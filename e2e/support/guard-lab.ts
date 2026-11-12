import { type ChildProcess } from "node:child_process";
import { createServer, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { Cdp } from "@fleet/protocol";
import { ChromeRelay } from "./chrome-relay.ts";
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

const FIELD_STYLE = `body{margin:0}input{display:block;box-sizing:border-box;width:240px;height:30px;margin:0}x-login,x-filled,x-sealed,x-built,x-held,x-nested{display:block;width:240px;height:30px}`;

const CLOSED = `<title>closed</title><style>${FIELD_STYLE}</style>
<input id="user" autocomplete="off"><x-login id="login"></x-login>
<script>
let field;
customElements.define("x-login", class extends HTMLElement {
  constructor() {
    super();
    const root = this.attachShadow({ mode: "closed" });
    root.innerHTML = '<style>${FIELD_STYLE}</style><input type="password" autocomplete="off">';
    field = root.querySelector("input");
  }
});
window.fieldValue = () => field.value;
</script>`;

const SEALED_ELEMENT = (
  tag: string,
): string => `customElements.define("${tag}", class extends HTMLElement {
  constructor() {
    super();
    this.internals = this.attachInternals();
  }
  peek() {
    return this.internals.shadowRoot.querySelector("input").value;
  }
});`;

const SEALED_MARKUP = (tag: string): string =>
  `<${tag} id="${tag}"><template shadowrootmode="closed"><style>${FIELD_STYLE}</style><input type="password" autocomplete="off"></template></${tag}>`;

const SEALED = `<title>sealed</title><style>${FIELD_STYLE}</style>
<input id="user" autocomplete="off">${SEALED_MARKUP("x-sealed")}
<script>${SEALED_ELEMENT("x-sealed")}</script>`;

const BUILT = `<title>built</title><style>${FIELD_STYLE}</style>
<input id="user" autocomplete="off"><div id="slot"></div>
<script>
${SEALED_ELEMENT("x-built")}
window.build = () => document.querySelector("#slot").setHTMLUnsafe(${JSON.stringify(SEALED_MARKUP("x-built"))});
</script>`;

const HELD = `<title>held</title><style>${FIELD_STYLE}</style>
<input id="user" autocomplete="off">
`;

const HELD_ROOT = `${SEALED_MARKUP("x-held")}
`;

const NESTED = `<title>nested</title><style>${FIELD_STYLE}</style>
<input id="user" autocomplete="off"><x-nested id="x-nested"><template shadowrootmode="closed"><style>${FIELD_STYLE}</style><div id="inner"><template shadowrootmode="open"><style>${FIELD_STYLE}</style><input type="password" autocomplete="off"></template></div></template></x-nested>
<script>
customElements.define("x-nested", class extends HTMLElement {
  constructor() {
    super();
    this.internals = this.attachInternals();
  }
  peek() {
    return this.internals.shadowRoot.querySelector("#inner").shadowRoot.querySelector("input").value;
  }
});
</script>`;

const DECLARED = `<title>declared</title><style>${FIELD_STYLE}</style>
<div><template shadowrootmode="open"><input type="password" value="declared-secret"></template></div>`;

const FILLED = `<title>filled</title><style>${FIELD_STYLE}</style>
<x-filled></x-filled>
<script>
customElements.define("x-filled", class extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" }).innerHTML = '<input type="password" value="seeded-secret">';
  }
});
</script>`;

const FRAME = `<style>body{margin:0}input{display:block;width:240px;height:30px;margin:0}</style><input id="pw" type="password" autocomplete="off">`;

const pagesFor = (port: number): ReadonlyMap<string, string> =>
  new Map([
    ["/login", LOGIN],
    ["/autofocus", AUTOFOCUS],
    ["/closed", CLOSED],
    ["/filled", FILLED],
    ["/declared", DECLARED],
    ["/sealed", SEALED],
    ["/built", BUILT],
    ["/nested", NESTED],
    [
      "/embed",
      `<title>embed</title><style>body{margin:0}iframe{display:block;border:0;width:300px;height:100px}</style><iframe id="inner" src="http://two.test:${String(port)}/frame"></iframe>`,
    ],
    ["/frame", FRAME],
  ]);

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
  private readonly held: ServerResponse[];

  private constructor(server: Server, port: number, submitted: string[], held: ServerResponse[]) {
    this.server = server;
    this.port = port;
    this.submitted = submitted;
    this.held = held;
  }

  static async start(): Promise<Site> {
    const submitted: string[] = [];
    const held: ServerResponse[] = [];
    let port = 0;
    const server = createServer((request, response) => {
      const path = request.url ?? "/";
      response.setHeader("content-type", "text/html");
      if (request.method === "POST" && path === "/submit") {
        void readBody(request).then((body) => {
          submitted.push(body);
          response.end("<title>welcome</title>welcome");
        });
      } else if (path === "/held") {
        response.write(HELD);
        held.push(response);
      } else response.end(pagesFor(port).get(path) ?? NOTES);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    port = typeof address === "object" && address !== null ? address.port : 0;
    return new Site(server, port, submitted, held);
  }

  url(path: string, host = "one.test"): string {
    return `http://${host}:${String(this.port)}${path}`;
  }

  continueHeld(): void {
    for (const response of this.held) response.write(HELD_ROOT);
  }

  release(): void {
    for (const response of this.held.splice(0)) response.end("<p>done</p>");
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
  readonly relay: ChromeRelay | undefined;
  private readonly scratch: Scratch;
  private readonly port: number;
  private readonly upstream: string;
  private child: ChildProcess | undefined;
  private readonly workers: Worker[] = [];

  private constructor(
    chrome: StandInChrome,
    site: Site,
    scratch: Scratch,
    port: number,
    upstream: string,
    child: ChildProcess | undefined,
    chromeArgs: readonly string[],
    relay: ChromeRelay | undefined,
  ) {
    this.chrome = chrome;
    this.chromeArgs = chromeArgs;
    this.site = site;
    this.scratch = scratch;
    this.port = port;
    this.upstream = upstream;
    this.child = child;
    this.relay = relay;
    this.proxy = `http://127.0.0.1:${String(port)}`;
    this.guard = WITHOUT_GUARD ? chrome.endpoint : this.proxy;
  }

  static async start(
    chromeArgs: readonly string[] = [],
    options: { readonly relay?: boolean } = {},
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
    const child = WITHOUT_GUARD ? undefined : spawnGuard(scratch, port, upstream);
    const lab = new GuardLab(chrome, site, scratch, port, upstream, child, chromeArgs, relay);
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
    this.child = spawnGuard(this.scratch, this.port, this.upstream);
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

function spawnGuard(scratch: Scratch, port: number, upstream: string): ChildProcess {
  const entry = join(scratch.root, "packages", "chrome", "src", "guard.ts");
  return spawnGuarded(
    "node",
    [entry, "--listen", `127.0.0.1:${String(port)}`, "--chrome", upstream],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
}
