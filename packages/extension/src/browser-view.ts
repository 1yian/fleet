import { spawn } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { check, HttpOutcomeSchema, OPS, type OpResult } from "@fleet/protocol";
import { InputSchema, Screen, type Frame } from "./browser-screen.ts";
import { VIEWER_PAGE } from "./browser-view-page.ts";
import { readLaneConfig } from "./lane-config.ts";
import { bwsFor, laneToken } from "./lane-secrets.ts";

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

const COOKIE = "fleet_viewer";

const digest = (text: string): Buffer => createHash("sha256").update(text).digest();

const json = (response: ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
};

class Viewer {
  private endpoint: string | undefined;
  private readonly cardd: Cardd;
  readonly screen = new Screen(() => this.endpoint);
  private allowed = new Set<string>();
  private readonly token: string;

  constructor(cardd: Cardd, token: string) {
    this.cardd = cardd;
    this.token = token;
  }

  private knows(candidate: string | null | undefined): boolean {
    if (candidate === null || candidate === undefined) return false;
    return timingSafeEqual(digest(candidate), digest(this.token));
  }

  private cookieOf(request: IncomingMessage): string | undefined {
    const pairs = (request.headers.cookie ?? "").split(";").map((part) => part.trim());
    const mine = pairs.find((pair) => pair.startsWith(`${COOKIE}=`));
    return mine?.slice(COOKIE.length + 1);
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

  private async stream(response: ServerResponse, target: string): Promise<void> {
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
    const send = (frame: Frame): void => {
      response.write(`data: ${JSON.stringify(frame)}\n\n`);
    };
    const watching: { stop: (() => void) | undefined } = { stop: undefined };
    response.on("close", () => {
      watching.stop?.();
    });
    watching.stop = await this.screen.watch(target, send, () => {
      response.end();
    });
    if (response.destroyed) watching.stop();
  }

  private async route(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    if (url.pathname === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(VIEWER_PAGE);
    } else if (url.pathname === "/api/tabs") json(response, 200, await this.tabs());
    else if (url.pathname === "/api/stream")
      await this.stream(response, url.searchParams.get("target") ?? "");
    else if (url.pathname === "/api/input" && request.method === "POST") {
      await this.screen.input(check(InputSchema, JSON.parse(await readBody(request))));
      response.writeHead(204).end();
    } else response.writeHead(404).end();
  }

  private enter(request: IncomingMessage, response: ServerResponse, url: URL): boolean {
    const offered = url.searchParams.get("t");
    if (this.knows(offered) && request.method === "GET" && url.pathname === "/") {
      url.searchParams.delete("t");
      response
        .writeHead(302, {
          location: `${url.pathname}${url.search}`,
          "set-cookie": `${COOKIE}=${this.token}; HttpOnly; SameSite=Strict; Path=/`,
        })
        .end();
      return false;
    }
    if (this.knows(offered) || this.knows(this.cookieOf(request))) return true;
    response.writeHead(403).end("the viewer needs its own address with its token");
    return false;
  }

  async answer(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.permits(request)) {
      response.writeHead(403).end("the viewer answers only on its own address");
      return;
    }
    try {
      const url = new URL(request.url ?? "/", "http://viewer");
      if (this.enter(request, response, url)) await this.route(request, response, url);
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
  const token = randomBytes(24).toString("base64url");
  const resolved = await laneToken(lane, bwsFor(lane.bws));
  if (resolved.value === undefined) throw new Error(`fleet: ${resolved.note}`);
  const viewer = new Viewer({ url: lane.url, token: resolved.value }, token);
  const server = createServer((request, response) => {
    void viewer.answer(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address: AddressInfo | string | null = server.address();
  if (address === null || typeof address === "string") throw new Error("the viewer has no address");
  viewer.allow(address.port);
  const url = `http://127.0.0.1:${String(address.port)}/?t=${token}`;
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
