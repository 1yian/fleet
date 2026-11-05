import { createConnection, createServer, type Server, type Socket } from "node:net";
import { Cdp } from "@fleet/protocol";
import { chromium, type Browser } from "playwright";
import { isRecord, optionalString } from "./json.ts";

export interface Target {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  readonly url: string;
}

export class StandInChrome {
  readonly endpoint: string;
  private readonly browser: Browser;

  private constructor(browser: Browser, endpoint: string) {
    this.browser = browser;
    this.endpoint = endpoint;
  }

  static async start(
    rules = "MAP *.example.test 127.0.0.1",
    wanted?: number,
    isolated = false,
  ): Promise<StandInChrome> {
    const port = wanted ?? (await freePort());
    const browser = await chromium.launch({
      args: [
        `--remote-debugging-port=${String(port)}`,
        `--host-resolver-rules=${rules}`,
        ...(isolated ? ["--site-per-process"] : []),
      ],
    });
    return new StandInChrome(browser, `http://127.0.0.1:${String(port)}`);
  }

  async targets(): Promise<Target[]> {
    const listed: unknown = await (await fetch(`${this.endpoint}/json/list`)).json();
    if (!Array.isArray(listed)) throw new Error("/json/list is not a list");
    return listed.filter(isRecord).map((each) => ({
      id: optionalString(each, "id") ?? "",
      type: optionalString(each, "type") ?? "",
      title: optionalString(each, "title") ?? "",
      url: optionalString(each, "url") ?? "",
    }));
  }

  async pages(): Promise<Target[]> {
    return (await this.targets()).filter((target) => target.type === "page");
  }

  async capture(target: string): Promise<string> {
    const cdp = await Cdp.connect(this.endpoint);
    try {
      const sessionId = await attach(cdp, target);
      const shot = await cdp.send("Page.captureScreenshot", { format: "png" }, { sessionId });
      const data = isRecord(shot) ? optionalString(shot, "data") : undefined;
      if (data === undefined) throw new Error("the tab gave no picture");
      return data;
    } finally {
      cdp.close();
    }
  }

  async navigate(target: string, url: string): Promise<void> {
    const cdp = await Cdp.connect(this.endpoint);
    try {
      const sessionId = await attach(cdp, target);
      const loaded = new Promise<void>((resolve) => {
        cdp.listen((event) => {
          if (event.sessionId === sessionId && event.method === "Page.loadEventFired") resolve();
        });
      });
      await cdp.send("Page.enable", {}, { sessionId });
      await cdp.send("Page.navigate", { url }, { sessionId });
      await loaded;
    } finally {
      cdp.close();
    }
  }

  async evaluate(target: string, expression: string): Promise<unknown> {
    const cdp = await Cdp.connect(this.endpoint);
    try {
      const sessionId = await attach(cdp, target);
      const done = await cdp.send(
        "Runtime.evaluate",
        { expression, returnByValue: true, awaitPromise: true },
        { sessionId },
      );
      const result = isRecord(done) ? done["result"] : undefined;
      return isRecord(result) ? result["value"] : undefined;
    } finally {
      cdp.close();
    }
  }

  get port(): number {
    return Number(new URL(this.endpoint).port);
  }

  async stop(): Promise<void> {
    await this.browser.close();
  }
}

async function attach(cdp: Cdp, target: string): Promise<string> {
  const attached = await cdp.send("Target.attachToTarget", { targetId: target, flatten: true });
  const sessionId = isRecord(attached) ? optionalString(attached, "sessionId") : undefined;
  if (sessionId === undefined) throw new Error("the tab did not attach");
  return sessionId;
}

export class TcpProxy {
  readonly port: number;
  private server: Server | undefined;
  private readonly sockets = new Set<Socket>();
  private readonly target: number;

  private constructor(port: number, target: number) {
    this.port = port;
    this.target = target;
  }

  static async start(target: number): Promise<TcpProxy> {
    const proxy = new TcpProxy(await freePort(), target);
    await proxy.listen();
    return proxy;
  }

  get endpoint(): string {
    return `http://127.0.0.1:${String(this.port)}`;
  }

  async listen(): Promise<void> {
    const server = createServer((client) => {
      const upstream = createConnection({ port: this.target, host: "127.0.0.1" });
      for (const socket of [client, upstream]) {
        this.sockets.add(socket);
        socket.on("close", () => this.sockets.delete(socket));
        socket.on("error", () => socket.destroy());
      }
      client.pipe(upstream).pipe(client);
    });
    await new Promise<void>((resolve) => server.listen(this.port, "127.0.0.1", resolve));
    this.server = server;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    for (const socket of this.sockets) socket.destroy();
    if (server !== undefined) await new Promise((resolve) => server.close(resolve));
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => {
        resolve(port);
      });
    });
  });
}
