import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { check, OPS } from "@fleet/protocol";
import { recordOf, runAxi } from "./browser-axi.ts";
import { rawWorker, RULES, type RawWorker } from "./browser-lab.ts";
import { Cardd, type Session } from "./cardd.ts";
import { StandInChrome } from "./chrome.ts";
import type { FakeVault } from "./fake-vault.ts";
import { begin, newCard } from "./fleet.ts";
import { parseRecord, type JsonRecord } from "./json.ts";
import { tempDir } from "./run-root.ts";
import { TestSite } from "./site.ts";

const TRANSPORT = fileURLToPath(new URL("./host-transport.ts", import.meta.url));

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
  readonly chromes: ReadonlyMap<string, StandInChrome>;
  readonly site: TestSite;
  readonly cardd: Cardd;
  readonly main: Session;
  private readonly sessions: Session[] = [];

  private constructor(parts: {
    dir: string;
    chromes: ReadonlyMap<string, StandInChrome>;
    site: TestSite;
    cardd: Cardd;
    main: Session;
  }) {
    this.dir = parts.dir;
    this.chromes = parts.chromes;
    this.site = parts.site;
    this.cardd = parts.cardd;
    this.main = parts.main;
  }

  static async start(specs: readonly HostSpec[]): Promise<HostLab> {
    const dir = tempDir("fleet-hosts-");
    const chromes = new Map<string, StandInChrome>();
    const browser: Record<string, unknown> = {};
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
      ["--hosts", JSON.stringify(routes), "--browser", JSON.stringify(browser)],
    );
    const clones = Object.fromEntries(specs.map(({ name }) => [name, "/clones/web"]));
    cardd.addProject("web", clones, "acme/web");
    const main = await cardd.connect(cardd.addLane("main"));
    return new HostLab({ dir, chromes, site, cardd, main });
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
    const stopped = await Promise.allSettled([
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
