import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Card } from "@fleet/protocol";
import { RULES } from "./browser-lab.ts";
import { transportFor } from "./browser-hosts.ts";
import { Cardd } from "./cardd.ts";
import { StandInChrome } from "./chrome.ts";
import type { FakeVault } from "./fake-vault.ts";
import { begin, newCard, WORKER_HOST } from "./fleet.ts";
import { Harness } from "./harness.ts";
import { HerdrLab } from "./herdr.ts";
import { parseRecord, records, type JsonRecord } from "./json.ts";
import { TestSite } from "./site.ts";
import { configureMain, mateArgs, Scratch, startMain } from "./scratch.ts";
import { tempDir } from "./run-root.ts";

const WAIT_MS = 60_000;
const ROOT = fileURLToPath(new URL("../..", import.meta.url));

export interface Worker {
  readonly card: Card;
  readonly token: string;
  readonly workspace: string;
  readonly pane: string;
}

export interface Frame {
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
}

function frameOf(sent: JsonRecord): Frame {
  const { data, width, height } = sent;
  if (typeof data !== "string" || typeof width !== "number" || typeof height !== "number")
    throw new Error("the stream sent a malformed picture");
  return { width, height, bytes: data.length };
}

export interface Mate {
  readonly lane: string;
  readonly home: string;
  readonly workspace: string;
  readonly worker: Worker;
}

export interface AxiResult {
  readonly code: number;
  readonly text: string;
}

export interface Hosts {
  readonly names: readonly string[];
  readonly mainHost: string;
}

async function startCardd(options: {
  browser: boolean;
  vault?: FakeVault;
  hosts?: Hosts;
  dir: string;
  names: readonly string[];
  chromes: ReadonlyMap<string, StandInChrome>;
}): Promise<Cardd> {
  const { vault, dir, names, chromes } = options;
  const config = Object.fromEntries(
    [...chromes].map(([name, each]) => [
      name,
      { cdp: each.endpoint, ...(vault === undefined ? {} : { logins: vault.logins() }) },
    ]),
  );
  const routes = Object.fromEntries(names.map((name) => [name, transportFor(dir, "cardd", name)]));
  const cardd = await Cardd.start(vault?.env ?? {}, [
    ...(options.hosts === undefined ? [] : ["--hosts", JSON.stringify(routes)]),
    ...(options.browser ? ["--browser", JSON.stringify(config)] : []),
  ]);
  const clones = Object.fromEntries([WORKER_HOST, ...names].map((name) => [name, "/clones/web"]));
  cardd.addProject("web", clones, "acme/web");
  return cardd;
}

export class BrowserHerdr {
  readonly chrome: StandInChrome;
  readonly chromes: ReadonlyMap<string, StandInChrome>;
  readonly dir: string;
  private readonly hosts: Hosts | undefined;
  readonly cardd: Cardd;
  readonly site: TestSite;
  readonly h: Harness;
  readonly lab: HerdrLab;
  readonly scratch: Scratch;
  readonly cards: Card[] = [];
  readonly tokens: string[] = [];
  mainPane = "";
  mainToken = "";
  private runs = 0;

  private constructor(parts: {
    chrome: StandInChrome;
    chromes: ReadonlyMap<string, StandInChrome>;
    dir: string;
    hosts: Hosts | undefined;
    cardd: Cardd;
    site: TestSite;
    h: Harness;
    lab: HerdrLab;
    scratch: Scratch;
  }) {
    this.chrome = parts.chrome;
    this.chromes = parts.chromes;
    this.dir = parts.dir;
    this.hosts = parts.hosts;
    this.cardd = parts.cardd;
    this.site = parts.site;
    this.h = parts.h;
    this.lab = parts.lab;
    this.scratch = parts.scratch;
  }

  static async start(options: {
    browser: boolean;
    vault?: FakeVault;
    hosts?: Hosts;
  }): Promise<BrowserHerdr> {
    const dir = tempDir("fleet-hosts-");
    const names = options.hosts?.names ?? [WORKER_HOST];
    const chromes = new Map<string, StandInChrome>();
    for (const name of names) chromes.set(name, await StandInChrome.start(RULES));
    const chrome = chromes.get(names[0] ?? WORKER_HOST);
    if (chrome === undefined) throw new Error("no host to start");
    const cardd = await startCardd({ ...options, dir, names, chromes });
    const h = await Harness.start();
    const lab = await HerdrLab.start({
      ...h.piEnv("mate"),
      PATH: `${join(ROOT, "bin")}:${join(ROOT, "node_modules/.bin")}:${process.env["PATH"] ?? ""}`,
      FLEET_BROWSER_VIEW_OPEN: "0",
    });
    return new BrowserHerdr({
      chrome,
      chromes,
      dir,
      hosts: options.hosts,
      cardd,
      site: await TestSite.start(),
      h,
      lab,
      scratch: new Scratch(),
    });
  }

  private routesOf(who: string): Record<string, string[]> {
    return Object.fromEntries(
      (this.hosts?.names ?? []).map((name) => [name, transportFor(this.dir, who, name)]),
    );
  }

  private async workspaceFor(card: Card, token: string): Promise<Worker> {
    const created = await this.lab.run([
      "workspace",
      "create",
      "--cwd",
      this.scratch.root,
      "--label",
      `worker c-${String(card.id)}`,
      "--no-focus",
    ]);
    const workspace = String(records([created["workspace"]])[0]?.["workspace_id"]);
    const pane = String(records([created["root_pane"]])[0]?.["pane_id"]);
    return { card, token, workspace, pane };
  }

  async workers(titles: readonly string[], host = WORKER_HOST): Promise<Worker[]> {
    this.mainToken = this.cardd.addLane("main", undefined, this.scratch.root);
    configureMain(this.scratch, this.cardd.url, this.mainToken, {
      host: this.hosts?.mainHost ?? WORKER_HOST,
      hosts: this.routesOf("main"),
    });
    const main = await this.cardd.connect(this.mainToken);
    const made: Worker[] = [];
    for (const title of titles) {
      const card = await newCard(main, title);
      const token = await begin(main, card, "browse", host);
      made.push(await this.workspaceFor(card, token));
    }
    await main.close();
    return made;
  }

  async startMate(lane: string, title: string, host: string): Promise<Mate> {
    const laneHost = host;
    const token = this.cardd.addLane(lane, "main");
    const session = await this.cardd.connect(token);
    const card = await newCard(session, title);
    const workerToken = await begin(session, card, "browse", host);
    await session.close();
    const home = this.scratch.addLane(lane, {
      url: this.cardd.url,
      token,
      args: mateArgs(this.h),
      host: laneHost,
      hosts: this.routesOf(lane),
    });
    const created = await this.lab.run([
      "workspace",
      "create",
      "--cwd",
      home,
      "--label",
      lane,
      "--no-focus",
    ]);
    const workspace = String(records([created["workspace"]])[0]?.["workspace_id"]);
    const pane = String(records([created["root_pane"]])[0]?.["pane_id"]);
    const connected = this.h.events.filter((event) => event["type"] === "fleet_connected").length;
    const probe = fileURLToPath(new URL("./probe.ts", import.meta.url));
    const command = [...mateArgs(this.h), "-e", probe].map((arg) => `'${arg}'`).join(" ");
    await this.lab.submit(pane, `cd '${home}' && FLEET_FAKE_AGENT='${lane}' pi ${command}`);
    await this.h.waitForNth(
      (event) => event["type"] === "fleet_connected",
      connected + 1,
      `${lane} to connect`,
    );
    return { lane, home, workspace, worker: await this.workspaceFor(card, workerToken) };
  }

  async focus(workspace: string): Promise<void> {
    await this.lab.run(["workspace", "focus", workspace]);
  }

  async startMain(): Promise<string> {
    this.mainPane = await startMain(this.lab, this.scratch, this.h);
    await this.h.waitFor((event) => event["type"] === "fleet_connected", "main to connect");
    return this.mainPane;
  }

  async mainWorkspace(): Promise<string> {
    const known = records((await this.lab.run(["pane", "list"]))["panes"]);
    return String(known.find((each) => each["pane_id"] === this.mainPane)?.["workspace_id"]);
  }

  async axi(worker: Worker, args: string, env: Record<string, string> = {}): Promise<AxiResult> {
    this.runs += 1;
    const out = join(this.scratch.root, `axi-${String(this.runs)}.out`);
    const code = join(this.scratch.root, `axi-${String(this.runs)}.code`);
    const given = {
      FLEET_BROWSER_URL: this.cardd.url,
      FLEET_BROWSER_TOKEN: worker.token,
      ...env,
    };
    const prefix = Object.entries(given)
      .map(([key, value]) => `${key}='${value}'`)
      .join(" ");
    await this.lab.submit(
      worker.pane,
      `${prefix} browser-axi ${args} --json > '${out}' 2>&1; echo $? > '${code}'`,
    );
    const finished = await until(`browser-axi ${args}`, () => exitOf(code));
    return { code: finished, text: readFileSync(out, "utf8") };
  }

  async tabLabels(workspace: string): Promise<string[]> {
    const tabs = records((await this.lab.run(["tab", "list", "--workspace", workspace]))["tabs"]);
    return tabs.map((tab) => String(tab["label"]));
  }

  async viewerPane(workspace: string): Promise<string> {
    const tabs = records((await this.lab.run(["tab", "list", "--workspace", workspace]))["tabs"]);
    const panes = records(
      (await this.lab.run(["pane", "list", "--workspace", workspace]))["panes"],
    );
    const tab = tabs.find((each) => each["label"] === "Browser");
    return String(panes.find((each) => each["tab_id"] === tab?.["tab_id"])?.["pane_id"]);
  }

  async viewerOf(workspace: string, mode?: "captain" | "gated"): Promise<string> {
    const tabs = records((await this.lab.run(["tab", "list", "--workspace", workspace]))["tabs"]);
    const panes = records(
      (await this.lab.run(["pane", "list", "--workspace", workspace]))["panes"],
    );
    const tab = tabs.find((each) => each["label"] === "Browser");
    const pane = String(panes.find((each) => each["tab_id"] === tab?.["tab_id"])?.["pane_id"]);
    const printed =
      /Fleet browser viewer \((captain|gated)\): (http:\/\/127\.0\.0\.1:\d+\/\?t=[\w-]+)/g;
    return until("the viewer's address", async () => {
      const last = [...(await this.lab.history(pane)).matchAll(printed)].at(-1);
      return last !== undefined && (mode === undefined || last[1] === mode) ? last[2] : undefined;
    });
  }

  async listingOf(address: string): Promise<{ body: string; tabs: JsonRecord[] }> {
    const cookie = await this.cookieFor(address);
    const body = await (await fetch(new URL("/api/tabs", address), { headers: { cookie } })).text();
    const tabs = parseRecord(body)["tabs"];
    assert.ok(Array.isArray(tabs));
    return { body, tabs: records(tabs) };
  }

  async tabsSeenBy(address: string): Promise<string[]> {
    return (await this.listingOf(address)).tabs.map((tab) => String(tab["label"]));
  }

  private async cookieFor(address: string): Promise<string> {
    const entered = await fetch(address, { redirect: "manual" });
    return entered.headers.get("set-cookie")?.split(";")[0] ?? "";
  }

  async streamOf(address: string, target: string): Promise<Stream> {
    const cookie = await this.cookieFor(address);
    const abort = new AbortController();
    const url = new URL(`/api/stream?target=${encodeURIComponent(target)}`, address);
    const response = await fetch(url, { headers: { cookie }, signal: abort.signal });
    assert.equal(response.status, 200);
    return new Stream(response, abort);
  }

  async streamStatus(address: string, target: string): Promise<number> {
    const cookie = await this.cookieFor(address);
    const url = new URL(`/api/stream?target=${encodeURIComponent(target)}`, address);
    const response = await fetch(url, { headers: { cookie } });
    await response.body?.cancel();
    return response.status;
  }

  async pictureOf(address: string, target: string): Promise<Frame> {
    const stream = await this.streamOf(address, target);
    try {
      return await until("a picture from the stream", () => {
        const sent = stream.messages.find((message) => typeof message["data"] === "string");
        return sent === undefined ? undefined : frameOf(sent);
      });
    } finally {
      await stream.stop();
    }
  }

  async inputStatus(address: string, target: string, at = { x: 5, y: 5 }): Promise<number> {
    const cookie = await this.cookieFor(address);
    let status = 204;
    for (const action of ["down", "up"]) {
      const response = await fetch(new URL("/api/input", address), {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({
          target,
          kind: "mouse",
          action,
          ...at,
          button: "left",
          buttons: action === "down" ? 1 : 0,
          clickCount: 1,
          modifiers: 0,
        }),
      });
      if (response.status !== 204) status = response.status;
    }
    return status;
  }

  async stop(t: object): Promise<void> {
    await this.lab.printIfFailed(t);
    const stopped = await Promise.allSettled([
      this.lab.stop(),
      this.h.stop(),
      this.cardd.stop(),
      ...[...this.chromes.values()].map((each) => each.stop()),
      this.site.stop(),
    ]);
    this.scratch.dispose();
    const failed = stopped.find((result) => result.status === "rejected");
    if (failed !== undefined) throw new Error(`cleanup failed: ${String(failed.reason)}`);
  }
}

export class Stream {
  raw = "";
  readonly messages: JsonRecord[] = [];
  private readonly abort: AbortController;
  private readonly reading: Promise<void>;
  private pending = "";

  constructor(response: Response, abort: AbortController) {
    this.abort = abort;
    this.reading = this.read(response);
  }

  private async read(response: Response): Promise<void> {
    const reader = response.body?.getReader();
    if (reader === undefined) return;
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) return;
        this.take(decoder.decode(chunk.value, { stream: true }));
      }
    } catch {
      return;
    }
  }

  private take(text: string): void {
    this.raw += text;
    this.pending += text;
    for (let end = this.pending.indexOf("\n\n"); end >= 0; end = this.pending.indexOf("\n\n")) {
      this.messages.push(parseRecord(this.pending.slice(0, end).replace(/^data: /, "")));
      this.pending = this.pending.slice(end + 2);
    }
  }

  async stop(): Promise<void> {
    this.abort.abort();
    await this.reading;
  }
}

function exitOf(file: string): number | undefined {
  try {
    const text = readFileSync(file, "utf8").trim();
    return text === "" ? undefined : Number(text);
  } catch {
    return undefined;
  }
}

export async function until<T>(
  what: string,
  read: () => Promise<T | undefined> | T | undefined,
): Promise<T> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}
