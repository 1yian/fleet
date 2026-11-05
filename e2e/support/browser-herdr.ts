import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Card } from "@fleet/protocol";
import { RULES } from "./browser-lab.ts";
import { Cardd } from "./cardd.ts";
import { StandInChrome } from "./chrome.ts";
import type { FakeVault } from "./fake-vault.ts";
import { begin, newCard } from "./fleet.ts";
import { Harness } from "./harness.ts";
import { HerdrLab } from "./herdr.ts";
import { parseRecord, records, type JsonRecord } from "./json.ts";
import { TestSite } from "./site.ts";
import { configureMain, Scratch, startMain } from "./scratch.ts";

const WAIT_MS = 60_000;
const ROOT = fileURLToPath(new URL("../..", import.meta.url));

export interface Worker {
  readonly card: Card;
  readonly token: string;
  readonly workspace: string;
  readonly pane: string;
}

export interface AxiResult {
  readonly code: number;
  readonly text: string;
}

export class BrowserHerdr {
  readonly chrome: StandInChrome;
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
    cardd: Cardd;
    site: TestSite;
    h: Harness;
    lab: HerdrLab;
    scratch: Scratch;
  }) {
    this.chrome = parts.chrome;
    this.cardd = parts.cardd;
    this.site = parts.site;
    this.h = parts.h;
    this.lab = parts.lab;
    this.scratch = parts.scratch;
  }

  static async start(options: { browser: boolean; vault?: FakeVault }): Promise<BrowserHerdr> {
    const chrome = await StandInChrome.start(RULES);
    const site = await TestSite.start();
    const config =
      options.vault === undefined
        ? JSON.stringify({ cdp: chrome.endpoint })
        : options.vault.config(chrome.endpoint);
    const cardd = await Cardd.start(
      options.vault?.env ?? {},
      options.browser ? ["--browser", config] : [],
    );
    cardd.addProject("web", { maverick: "/clones/web" }, "acme/web");
    const h = await Harness.start();
    const scratch = new Scratch();
    const lab = await HerdrLab.start({
      ...h.piEnv("mate"),
      PATH: `${join(ROOT, "bin")}:${join(ROOT, "node_modules/.bin")}:${process.env["PATH"] ?? ""}`,
      FLEET_BROWSER_VIEW_OPEN: "0",
    });
    return new BrowserHerdr({ chrome, cardd, site, h, lab, scratch });
  }

  async workers(titles: readonly string[]): Promise<Worker[]> {
    this.mainToken = this.cardd.addLane("main", undefined, this.scratch.root);
    configureMain(this.scratch, this.cardd.url, this.mainToken);
    const main = await this.cardd.connect(this.mainToken);
    const made: Worker[] = [];
    for (const title of titles) {
      const card = await newCard(main, title);
      const token = await begin(main, card, "browse");
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
      made.push({ card, token, workspace, pane });
    }
    await main.close();
    return made;
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

  async inputStatus(address: string, target: string, at = { x: 5, y: 5 }): Promise<number> {
    const cookie = await this.cookieFor(address);
    const response = await fetch(new URL("/api/input", address), {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ target, kind: "click", ...at }),
    });
    return response.status;
  }

  async stop(t: object): Promise<void> {
    await this.lab.printIfFailed(t);
    const stopped = await Promise.allSettled([
      this.lab.stop(),
      this.h.stop(),
      this.cardd.stop(),
      this.chrome.stop(),
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
