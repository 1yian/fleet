import { type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { Cdp } from "@fleet/protocol";
import { ChromeRelay } from "./chrome-relay.ts";
import { StandInChrome, freePort } from "./chrome.ts";
import { spawnGuarded } from "./guarded.ts";
import { Site } from "./guard-site.ts";
import { isRecord, optionalNumber, optionalString } from "./json.ts";
import { Scratch } from "./scratch.ts";

const WAIT_MS = 30_000;
const WITHOUT_GUARD = process.env["FLEET_E2E_WITHOUT_GUARD"] === "1";

export async function until<T>(
  read: () => T | undefined | Promise<T | undefined>,
  what: string,
): Promise<T> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export async function reads(
  worker: Worker,
  session: string,
  expression: string,
  text: string,
): Promise<void> {
  await until(async () => {
    const reply = await worker.evaluate(session, expression);
    return reply.ok && reply.text === text ? true : undefined;
  }, `${expression} to read ${text}`);
}

export interface Reply {
  readonly ok: boolean;
  readonly text: string;
}

const textOf = (value: unknown): string => {
  const result = isRecord(value) ? value["result"] : undefined;
  return JSON.stringify(isRecord(result) && "value" in result ? result["value"] : value);
};

export class Worker {
  readonly cdp: Cdp;
  readonly events: { method: string; params: unknown; sessionId: string | undefined }[] = [];

  private constructor(cdp: Cdp) {
    this.cdp = cdp;
    cdp.listen((event) => this.events.push(event));
  }

  static async connect(endpoint: string): Promise<Worker> {
    return new Worker(await Cdp.connect(endpoint));
  }

  async open(url: string): Promise<{ target: string; session: string }> {
    const created = await this.cdp.send("Target.createTarget", { url });
    const target = isRecord(created) ? optionalString(created, "targetId") : undefined;
    if (target === undefined) throw new Error("the browser opened no tab");
    return { target, session: await this.attach(target) };
  }

  async attach(target: string): Promise<string> {
    const attached = await this.cdp.send("Target.attachToTarget", {
      targetId: target,
      flatten: true,
    });
    const session = isRecord(attached) ? optionalString(attached, "sessionId") : undefined;
    if (session === undefined) throw new Error("the tab did not attach");
    return session;
  }

  async call(session: string, method: string, params: unknown = {}): Promise<Reply> {
    try {
      const done = await this.cdp.send(method, params, { sessionId: session, timeoutMs: 15_000 });
      return { ok: true, text: textOf(done) };
    } catch (error) {
      return { ok: false, text: error instanceof Error ? error.message : String(error) };
    }
  }

  evaluate(session: string, expression: string): Promise<Reply> {
    return this.call(session, "Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
  }

  close(): void {
    this.cdp.close();
  }
}

export class Captain {
  private readonly chrome: StandInChrome;
  private readonly cdp: Cdp;
  private readonly session: string;

  private constructor(chrome: StandInChrome, cdp: Cdp, session: string) {
    this.chrome = chrome;
    this.cdp = cdp;
    this.session = session;
  }

  static async at(chrome: StandInChrome, target: string): Promise<Captain> {
    const cdp = await Cdp.connect(chrome.endpoint);
    const attached = await cdp.send("Target.attachToTarget", { targetId: target, flatten: true });
    const session = isRecord(attached) ? optionalString(attached, "sessionId") : undefined;
    if (session === undefined) throw new Error("the captain's pointer found no tab");
    return new Captain(chrome, cdp, session);
  }

  async clickAt(x: number, y: number): Promise<void> {
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
      await this.cdp.send(
        "Input.dispatchMouseEvent",
        { type, x, y, button: "left", clickCount: 1 },
        { sessionId: this.session },
      );
    }
  }

  async clickIntoFrame(frame: string, selector: string, x: number, y: number): Promise<void> {
    const focused = `document.activeElement === document.querySelector(${JSON.stringify(selector)})`;
    await until(async () => {
      await this.clickAt(x, y);
      return (await this.chrome.evaluate(frame, focused)) === true ? true : undefined;
    }, `the click to reach ${selector} in the frame`);
  }

  async click(selector: string): Promise<void> {
    const found = await this.cdp.send(
      "Runtime.evaluate",
      {
        expression: `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
        returnByValue: true,
      },
      { sessionId: this.session },
    );
    const result = isRecord(found) ? found["result"] : undefined;
    const point = isRecord(result) ? result["value"] : undefined;
    const x = isRecord(point) ? optionalNumber(point, "x") : undefined;
    const y = isRecord(point) ? optionalNumber(point, "y") : undefined;
    if (x === undefined || y === undefined) throw new Error(`${selector} is not on the page`);
    await this.clickAt(x, y);
  }

  async type(text: string): Promise<void> {
    for (const character of text) {
      for (const type of ["keyDown", "keyUp"]) {
        await this.cdp.send(
          "Input.dispatchKeyEvent",
          { type, text: type === "keyDown" ? character : undefined, key: character },
          { sessionId: this.session },
        );
      }
    }
  }

  async press(key: "Enter" | "Backspace"): Promise<void> {
    const enter = key === "Enter";
    const code = enter ? 13 : 8;
    const down = enter ? "keyDown" : "rawKeyDown";
    await this.cdp.send(
      "Input.dispatchKeyEvent",
      { type: down, key, windowsVirtualKeyCode: code, text: enter ? "\r" : undefined },
      { sessionId: this.session },
    );
    await this.cdp.send(
      "Input.dispatchKeyEvent",
      { type: "keyUp", key, windowsVirtualKeyCode: code },
      { sessionId: this.session },
    );
  }

  async erase(count: number): Promise<void> {
    for (let index = 0; index < count; index++) await this.press("Backspace");
  }

  close(): void {
    this.cdp.close();
  }
}

export class GuardLab {
  chrome: StandInChrome;
  readonly site: Site;
  private readonly chromeArgs: readonly string[];
  readonly guard: string;
  readonly proxy: string;
  readonly relay: ChromeRelay | undefined;
  private readonly scratch: Scratch;
  private readonly port: number;
  private readonly launch: () => ChildProcess;
  private child: ChildProcess | undefined;
  private readonly workers: Worker[] = [];

  private constructor(
    chrome: StandInChrome,
    site: Site,
    scratch: Scratch,
    port: number,
    launch: () => ChildProcess,
    child: ChildProcess | undefined,
    chromeArgs: readonly string[],
    relay: ChromeRelay | undefined,
  ) {
    this.chrome = chrome;
    this.chromeArgs = chromeArgs;
    this.site = site;
    this.scratch = scratch;
    this.port = port;
    this.launch = launch;
    this.child = child;
    this.relay = relay;
    this.proxy = `http://127.0.0.1:${String(port)}`;
    this.guard = WITHOUT_GUARD ? chrome.endpoint : this.proxy;
  }

  static async start(
    chromeArgs: readonly string[] = [],
    options: { readonly relay?: boolean; readonly parseWaitMs?: number } = {},
  ): Promise<GuardLab> {
    const scratch = new Scratch("guard");
    const chrome = await StandInChrome.start("MAP *.test 127.0.0.1", chromeArgs);
    const site = await Site.start();
    const port = await freePort();
    const relay =
      options.relay === true && !WITHOUT_GUARD
        ? await ChromeRelay.start(chrome.endpoint.replace("http://", ""))
        : undefined;
    const upstream = relay?.address ?? chrome.endpoint.replace("http://", "");
    const guardArgs =
      options.parseWaitMs === undefined ? [] : ["--parse-wait-ms", String(options.parseWaitMs)];
    const launch = (): ChildProcess => spawnGuard(scratch, port, upstream, guardArgs);
    const child = WITHOUT_GUARD ? undefined : launch();
    const lab = new GuardLab(chrome, site, scratch, port, launch, child, chromeArgs, relay);
    if (!WITHOUT_GUARD) await lab.listening();
    return lab;
  }

  get root(): string {
    return this.scratch.root;
  }

  get guardPort(): number {
    return this.port;
  }

  async listening(): Promise<void> {
    await until(async () => {
      try {
        const response = await fetch(`${this.proxy}/json/version`);
        return response.headers.has("x-fleet-guard") ? true : undefined;
      } catch {
        return undefined;
      }
    }, "the guard to answer");
  }

  async restartGuard(): Promise<void> {
    await this.stopGuard();
    this.child = this.launch();
    await this.listening();
  }

  async restartChrome(): Promise<void> {
    const port = Number(new URL(this.chrome.endpoint).port);
    await this.chrome.stop();
    this.chrome = await StandInChrome.start("MAP *.test 127.0.0.1", this.chromeArgs, port);
  }

  async stopGuard(): Promise<void> {
    const child = this.child;
    if (child?.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) =>
      child.once("exit", () => {
        resolve();
      }),
    );
    child.kill("SIGTERM");
    await exited;
  }

  async worker(): Promise<Worker> {
    const worker = await Worker.connect(this.guard);
    this.workers.push(worker);
    return worker;
  }

  async openPage(
    worker: Worker,
    path: string,
    title: string,
  ): Promise<{ target: string; session: string }> {
    const tab = await worker.open("about:blank");
    const navigated = await worker.call(tab.session, "Page.navigate", { url: this.site.url(path) });
    if (!navigated.ok) throw new Error(`${path} was refused: ${navigated.text}`);
    await until(async () => {
      const read = await worker.evaluate(tab.session, "document.title");
      return read.text === JSON.stringify(title) ? true : undefined;
    }, `${path} to load`);
    return tab;
  }

  async waitForTab(url: string, title: string): Promise<string> {
    return until(async () => {
      const found = (await this.chrome.pages()).find(
        (page) => page.url === this.site.url(url) && page.title === title,
      );
      return found?.id;
    }, `${url} to load`);
  }

  async stop(): Promise<void> {
    for (const worker of this.workers) worker.close();
    await this.stopGuard();
    await this.relay?.stop();
    await this.chrome.stop();
    await this.site.stop();
    this.scratch.dispose();
  }
}

function spawnGuard(
  scratch: Scratch,
  port: number,
  upstream: string,
  extra: readonly string[],
): ChildProcess {
  const entry = join(scratch.root, "packages", "chrome", "src", "guard.ts");
  return spawnGuarded(
    "node",
    [entry, "--listen", `127.0.0.1:${String(port)}`, "--chrome", upstream, ...extra],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
}
