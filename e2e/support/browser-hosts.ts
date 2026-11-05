import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { check, OPS } from "@fleet/protocol";
import { recordOf, runAxi } from "./browser-axi.ts";
import { rawWorker, RULES, type RawWorker } from "./browser-lab.ts";
import { Cardd, type Session } from "./cardd.ts";
import { StandInChrome } from "./chrome.ts";
import type { FakeVault } from "./fake-vault.ts";
import { begin, newCard } from "./fleet.ts";
import { spawnGuarded } from "./guarded.ts";
import { parseRecord, records, type JsonRecord } from "./json.ts";
import { tempDir } from "./run-root.ts";
import { TestSite } from "./site.ts";

const TRANSPORT = fileURLToPath(new URL("./host-transport.ts", import.meta.url));
const VIEWER = fileURLToPath(
  new URL("../../packages/extension/src/browser-view.ts", import.meta.url),
);
const VIEWER_WAIT_MS = 15_000;

interface BrowserSpec {
  readonly cdp: string;
  readonly logins?: Record<string, unknown>;
}

export interface HostSpec {
  readonly name: string;
  readonly vault?: FakeVault;
  readonly browser?: boolean;
  readonly route?: boolean;
  readonly hangs?: boolean;
}

export const transportFor = (
  dir: string,
  who: string,
  host: string,
  vault?: FakeVault,
): string[] => [
  "node",
  TRANSPORT,
  host,
  join(dir, `${who}-${host}.log`),
  ...(vault === undefined ? [] : [`FAKE_BWS_DIR=${vault.dir}`]),
];

async function cookieFor(address: string): Promise<string> {
  const entered = await fetch(address, { redirect: "manual" });
  return entered.headers.get("set-cookie")?.split(";")[0] ?? "";
}

const serveArgs = (
  routes: Record<string, string[]>,
  browser: Record<string, BrowserSpec>,
): string[] => ["--hosts", JSON.stringify(routes), "--browser", JSON.stringify(browser)];

const routeOf = (dir: string, { name, vault, hangs = false }: HostSpec): string[] => [
  ...transportFor(dir, "cardd", name, vault),
  ...(hangs ? ["FAKE_TRANSPORT_HANGS=1"] : []),
];

export function transportLog(dir: string, who: string, host: string): string[] {
  try {
    return readFileSync(join(dir, `${who}-${host}.log`), "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => String(parseRecord(line)["command"]));
  } catch {
    return [];
  }
}

export function relayPorts(commands: readonly string[]): number[] {
  return commands.flatMap((command) => {
    const port = /'(\d+)'$/.exec(command)?.[1];
    return command.includes("net.connect") && port !== undefined ? [Number(port)] : [];
  });
}

interface Run {
  readonly code: number;
  readonly record: JsonRecord;
}

export interface HostWorker extends RawWorker {
  readonly run: (args: readonly string[]) => Promise<Run>;
}

function hostWorker(base: RawWorker): HostWorker {
  return {
    ...base,
    run: async (args) => {
      const done = await runAxi([...args, "--json"], base.access);
      return { code: done.code, record: recordOf(done) };
    },
  };
}

export class HostLab {
  readonly dir: string;
  readonly chromes: Map<string, StandInChrome>;
  readonly site: TestSite;
  readonly cardd: Cardd;
  main: Session;
  private readonly mainToken: string;
  private readonly routes: Record<string, string[]>;
  private readonly browser: Record<string, BrowserSpec>;
  private readonly sessions: Session[] = [];
  private readonly viewers: ReturnType<typeof spawnGuarded>[] = [];

  private constructor(parts: {
    dir: string;
    chromes: Map<string, StandInChrome>;
    site: TestSite;
    cardd: Cardd;
    main: Session;
    mainToken: string;
    routes: Record<string, string[]>;
    browser: Record<string, BrowserSpec>;
  }) {
    this.dir = parts.dir;
    this.chromes = parts.chromes;
    this.site = parts.site;
    this.cardd = parts.cardd;
    this.main = parts.main;
    this.mainToken = parts.mainToken;
    this.routes = parts.routes;
    this.browser = parts.browser;
  }

  static async start(specs: readonly HostSpec[]): Promise<HostLab> {
    const dir = tempDir("fleet-hosts-");
    const chromes = new Map<string, StandInChrome>();
    const browser: Record<string, BrowserSpec> = {};
    const routes: Record<string, string[]> = {};
    for (const spec of specs) {
      const { name, vault, browser: wanted = true, route = true } = spec;
      if (route) routes[name] = routeOf(dir, spec);
      if (!wanted) continue;
      const chrome = await StandInChrome.start(RULES);
      chromes.set(name, chrome);
      browser[name] = {
        cdp: chrome.endpoint,
        ...(vault === undefined ? {} : { logins: vault.logins() }),
      };
    }
    const withVault = specs.find((spec) => spec.vault !== undefined)?.vault;
    const site = await TestSite.start();
    const cardd = await Cardd.start(
      withVault === undefined ? {} : { PATH: withVault.env["PATH"] ?? "" },
      serveArgs(routes, browser),
    );
    const clones = Object.fromEntries(specs.map(({ name }) => [name, "/clones/web"]));
    cardd.addProject("web", clones, "acme/web");
    const mainToken = cardd.addLane("main");
    const main = await cardd.connect(mainToken);
    return new HostLab({ dir, chromes, site, cardd, main, mainToken, routes, browser });
  }

  async rebrowse(hosts: readonly string[]): Promise<void> {
    const named = Object.fromEntries(
      Object.entries(this.browser).filter(([host]) => hosts.includes(host)),
    );
    await this.cardd.restart(serveArgs(this.routes, named));
    this.main = await this.cardd.connect(this.mainToken);
    this.sessions.length = 0;
  }

  async moveBrowser(host: string): Promise<void> {
    const old = this.chrome(host);
    const fresh = await StandInChrome.start(RULES);
    this.chromes.set(host, fresh);
    this.browser[host] = { ...this.browser[host], cdp: fresh.endpoint };
    await old.stop();
    await this.cardd.restart(serveArgs(this.routes, this.browser));
    this.main = await this.cardd.connect(this.mainToken);
    this.sessions.length = 0;
  }

  async viewer(host: string): Promise<string> {
    const access = join(tempDir("fleet-viewer-access-"), "access.json");
    writeFileSync(access, JSON.stringify({ url: this.cardd.url, token: this.mainToken, host }), {
      mode: 0o600,
    });
    const viewer = spawnGuarded("node", [VIEWER, "--access", access, "--captain"], {
      stdio: ["ignore", "pipe", "inherit"],
      env: { ...process.env, FLEET_BROWSER_VIEW_OPEN: "0" },
    });
    this.viewers.push(viewer);
    let said = "";
    viewer.stdout?.setEncoding("utf8").on("data", (chunk: string) => (said += chunk));
    const deadline = Date.now() + VIEWER_WAIT_MS;
    for (;;) {
      const found = /Fleet browser viewer \(captain\): (\S+)/.exec(said)?.[1];
      if (found !== undefined) return found;
      assert.ok(Date.now() < deadline, "the viewer did not print its address");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  async viewerTargets(address: string): Promise<string[]> {
    const cookie = await cookieFor(address);
    const body = await (await fetch(new URL("/api/tabs", address), { headers: { cookie } })).text();
    const tabs = parseRecord(body)["tabs"];
    assert.ok(Array.isArray(tabs));
    return records(tabs).map((tab) => String(tab["target"]));
  }

  async viewerPicture(address: string, target: string): Promise<number> {
    const cookie = await cookieFor(address);
    const abort = new AbortController();
    const url = new URL(`/api/stream?target=${encodeURIComponent(target)}`, address);
    const response = await fetch(url, {
      headers: { cookie },
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(VIEWER_WAIT_MS)]),
    });
    try {
      assert.equal(response.status, 200);
      const reader = response.body?.getReader();
      assert.ok(reader !== undefined);
      const decoder = new TextDecoder();
      let seen = "";
      while (!seen.includes('"data":"')) {
        const { done, value } = await reader.read();
        assert.ok(!done, "the stream ended before a picture");
        seen += decoder.decode(value, { stream: true });
      }
      return seen.length;
    } finally {
      abort.abort();
    }
  }

  chrome(host: string): StandInChrome {
    const found = this.chromes.get(host);
    if (found === undefined) throw new Error(`no Chrome for ${host}`);
    return found;
  }

  async pathsOn(host: string): Promise<string[]> {
    return (await this.chrome(host).pages()).map((page) => new URL(page.url).pathname);
  }

  async worker(title: string, host: string): Promise<HostWorker> {
    const card = await newCard(this.main, title);
    const token = await begin(this.main, card, "browse", host);
    const session = await this.cardd.connect(token);
    this.sessions.push(session);
    return hostWorker(rawWorker(card, token, session, this.cardd.url));
  }

  async lane(name: string): Promise<Session> {
    const session = await this.cardd.connect(this.cardd.addLane(name, "main"));
    this.sessions.push(session);
    return session;
  }

  async tabHosts(): Promise<string[]> {
    const view = check(OPS["browser.view"].result, await this.main.call("browser.view", {}));
    return view.tabs.map((tab) => `${String(tab.card)}@${tab.host}`);
  }

  commands(who: string, host: string): string[] {
    return transportLog(this.dir, who, host);
  }

  async stop(): Promise<void> {
    const exits = this.viewers.splice(0).map((viewer) => {
      const exited = new Promise((resolve) => viewer.once("exit", resolve));
      viewer.kill("SIGTERM");
      return exited;
    });
    const stopped = await Promise.allSettled([
      ...exits,
      this.main.close(),
      ...this.sessions.splice(0).map((session) => session.close()),
      this.cardd.stop(),
      ...[...this.chromes.values()].map((chrome) => chrome.stop()),
      this.site.stop(),
    ]);
    const failed = stopped.find((result) => result.status === "rejected");
    if (failed !== undefined) throw new Error(`cleanup failed: ${String(failed.reason)}`);
  }
}
