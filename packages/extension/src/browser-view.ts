import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { check, HttpOutcomeSchema, OPS, type OpResult } from "@fleet/protocol";
import { InputSchema, Screen, type Frame } from "./browser-screen.ts";
import { VIEWER_PAGE } from "./browser-view-page.ts";
import { readLaneConfig } from "./lane-config.ts";

interface Cardd {
  readonly url: string;
  readonly token: string;
}

type View = OpResult<"browser.view">;

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));

async function callView(cardd: Cardd): Promise<View> {
  const response = await fetch(cardd.url.replace(/^ws/, "http").replace(/\/session$/, "/call"), {
    method: "POST",
    headers: { authorization: `Bearer ${cardd.token}`, "content-type": "application/json" },
    body: JSON.stringify({ op: "browser.view", args: {} }),
    signal: AbortSignal.timeout(15_000),
  });
  const outcome = check(HttpOutcomeSchema, await response.json());
  if (!outcome.ok) throw new Error(outcome.error);
  return check(OPS["browser.view"].result, outcome.value);
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => (body += chunk));
    request.on("end", () => {
      resolve(body);
    });
    request.on("error", reject);
  });
}

const json = (response: ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
};

class Viewer {
  private endpoint: string | undefined;
  private readonly cardd: Cardd;
  readonly screen = new Screen(() => this.endpoint);
  private allowed = new Set<string>();

  constructor(cardd: Cardd) {
    this.cardd = cardd;
  }

  allow(port: number): void {
    this.allowed = new Set([`127.0.0.1:${String(port)}`, `localhost:${String(port)}`]);
  }

  private permits(request: IncomingMessage): boolean {
    const host = request.headers.host;
    if (host === undefined || !this.allowed.has(host)) return false;
    const origin = request.headers.origin;
    return origin === undefined || this.allowed.has(origin.replace(/^http:\/\//, ""));
  }

  private async tabs(): Promise<{ tabs: unknown[]; problem: string | null }> {
    const view = await callView(this.cardd);
    this.endpoint = view.endpoint ?? undefined;
    const known = await this.screen.live().then(
      (found) => ({ found, problem: null }),
      (error: unknown) => ({
        found: undefined,
        problem: `The shared browser is unreachable: ${reason(error)}`,
      }),
    );
    const tabs = view.tabs.map((tab) => {
      const here = known.found?.get(tab.target);
      return {
        ...tab,
        live: here !== undefined,
        title: (here?.title ?? "").replace(`${tab.label} - `, "").replace(tab.label, ""),
        url: here?.url ?? "",
      };
    });
    return { tabs, problem: known.problem };
  }

  private async stream(
    request: IncomingMessage,
    response: ServerResponse,
    target: string,
  ): Promise<void> {
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
    const send = (frame: Frame): void => {
      response.write(`data: ${JSON.stringify(frame)}\n\n`);
    };
    const stop = await this.screen.watch(target, send, () => {
      response.end();
    });
    request.on("close", stop);
  }

  private async route(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    if (url.pathname === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(VIEWER_PAGE);
    } else if (url.pathname === "/api/tabs") json(response, 200, await this.tabs());
    else if (url.pathname === "/api/stream")
      await this.stream(request, response, url.searchParams.get("target") ?? "");
    else if (url.pathname === "/api/input" && request.method === "POST") {
      await this.screen.input(check(InputSchema, JSON.parse(await readBody(request))));
      response.writeHead(204).end();
    } else response.writeHead(404).end();
  }

  async answer(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.permits(request)) {
      response.writeHead(403).end("the viewer answers only on its own address");
      return;
    }
    try {
      await this.route(request, response, new URL(request.url ?? "/", "http://viewer"));
    } catch (error) {
      if (response.headersSent) response.end();
      else json(response, 502, { error: reason(error) });
    }
  }
}

function open(url: string): void {
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  const child = spawn(opener, [url], { stdio: "ignore", detached: true });
  child.on("error", () => undefined);
  child.unref();
}

async function main(): Promise<void> {
  const [home = process.cwd(), ...flags] = process.argv.slice(2);
  const lane = readLaneConfig(home);
  if (lane === undefined) throw new Error(`${home} has no config/lane.json`);
  const viewer = new Viewer({ url: lane.url, token: lane.token });
  const server = createServer((request, response) => {
    void viewer.answer(request, response);
  });
  const wanted = Number(process.env["FLEET_BROWSER_VIEW_PORT"] ?? "0");
  await new Promise<void>((resolve) => server.listen(wanted, "127.0.0.1", resolve));
  const address: AddressInfo | string | null = server.address();
  if (address === null || typeof address === "string") throw new Error("the viewer has no address");
  viewer.allow(address.port);
  const url = `http://127.0.0.1:${String(address.port)}/`;
  console.log(`Fleet browser viewer: ${url}`);
  if (flags.includes("--open") && process.env["FLEET_BROWSER_VIEW_OPEN"] !== "0") open(url);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      viewer.screen.close();
      server.close();
      process.exit(0);
    });
  }
}

main().catch((error: unknown) => {
  console.error(reason(error));
  process.exit(1);
});
