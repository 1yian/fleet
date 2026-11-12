import { type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { Cdp } from "@fleet/protocol";
import { StandInChrome, freePort } from "./chrome.ts";
import { spawnGuarded } from "./guarded.ts";
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

const LOGIN = `<title>login</title><style>body{margin:0}input{display:block;width:240px;height:30px;margin:0}</style>
<form id="f" method="post" action="/submit"><input id="user" name="user" autocomplete="off"><input id="pw" name="pw" type="password" autocomplete="off"><button id="go">Sign in</button></form>`;

const AUTOFOCUS = LOGIN.replace(
  'autocomplete="off"><button',
  'autocomplete="off" autofocus><button',
).replace("<title>login</title>", "<title>autofocus</title>");

const NOTES = `<title>notes</title><p id="note">plain notes</p>`;

const readBody = (request: NodeJS.ReadableStream): Promise<string> =>
  new Promise((resolve) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });

export class Site {
  readonly submitted: string[];
  readonly port: number;
  private readonly server: Server;

  private constructor(server: Server, port: number, submitted: string[]) {
    this.server = server;
    this.port = port;
    this.submitted = submitted;
  }

  static async start(): Promise<Site> {
    const submitted: string[] = [];
    let port = 0;
    const server = createServer((request, response) => {
      const path = request.url ?? "/";
      response.setHeader("content-type", "text/html");
      if (request.method === "POST" && path === "/submit") {
        void readBody(request).then((body) => {
          submitted.push(body);
          response.end("<title>welcome</title>welcome");
        });
      } else if (path === "/login") response.end(LOGIN);
      else if (path === "/autofocus") response.end(AUTOFOCUS);
      else if (path === "/embed")
        response.end(
          `<title>embed</title><style>body{margin:0}iframe{display:block;border:0;width:300px;height:100px}</style><iframe id="inner" src="http://two.test:${String(port)}/frame"></iframe>`,
        );
      else if (path === "/frame")
        response.end(
          `<style>body{margin:0}input{display:block;width:240px;height:30px;margin:0}</style><input id="pw" type="password" autocomplete="off">`,
        );
      else response.end(NOTES);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    port = typeof address === "object" && address !== null ? address.port : 0;
    return new Site(server, port, submitted);
  }

  url(path: string, host = "one.test"): string {
    return `http://${host}:${String(this.port)}${path}`;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) =>
      this.server.close(() => {
        resolve();
      }),
    );
  }
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
  private readonly cdp: Cdp;
  private readonly session: string;

  private constructor(cdp: Cdp, session: string) {
    this.cdp = cdp;
    this.session = session;
  }

  static async at(chrome: StandInChrome, target: string): Promise<Captain> {
    const cdp = await Cdp.connect(chrome.endpoint);
    const attached = await cdp.send("Target.attachToTarget", { targetId: target, flatten: true });
    const session = isRecord(attached) ? optionalString(attached, "sessionId") : undefined;
    if (session === undefined) throw new Error("the captain's pointer found no tab");
    return new Captain(cdp, session);
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
  private readonly scratch: Scratch;
  private readonly port: number;
  private child: ChildProcess | undefined;
  private readonly workers: Worker[] = [];

  private constructor(
    chrome: StandInChrome,
    site: Site,
    scratch: Scratch,
    port: number,
    child: ChildProcess | undefined,
    chromeArgs: readonly string[],
  ) {
    this.chrome = chrome;
    this.chromeArgs = chromeArgs;
    this.site = site;
    this.scratch = scratch;
    this.port = port;
    this.child = child;
    this.proxy = `http://127.0.0.1:${String(port)}`;
    this.guard = WITHOUT_GUARD ? chrome.endpoint : this.proxy;
  }

  static async start(chromeArgs: readonly string[] = []): Promise<GuardLab> {
    const scratch = new Scratch("guard");
    const chrome = await StandInChrome.start("MAP *.test 127.0.0.1", chromeArgs);
    const site = await Site.start();
    const port = await freePort();
    const child = WITHOUT_GUARD ? undefined : spawnGuard(scratch, port, chrome.endpoint);
    const lab = new GuardLab(chrome, site, scratch, port, child, chromeArgs);
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
    this.child = spawnGuard(this.scratch, this.port, this.chrome.endpoint);
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

  async stop(): Promise<void> {
    for (const worker of this.workers) worker.close();
    await this.stopGuard();
    await this.chrome.stop();
    await this.site.stop();
    this.scratch.dispose();
  }
}

function spawnGuard(scratch: Scratch, port: number, chrome: string): ChildProcess {
  const entry = join(scratch.root, "packages", "chrome", "src", "guard.ts");
  return spawnGuarded(
    "node",
    [entry, "--listen", `127.0.0.1:${String(port)}`, "--chrome", chrome.replace("http://", "")],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
}
