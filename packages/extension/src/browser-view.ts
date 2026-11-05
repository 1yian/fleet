import { spawn } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { check, HttpOutcomeSchema, OPS, type OpResult } from "@fleet/protocol";
import { dial } from "@fleet/protocol/tunnel";
import { Poll, type Pulled, type Shown } from "./browser-poll.ts";
import { InputSchema, Screen } from "./browser-screen.ts";
import { VIEWER_PAGE } from "./browser-view-page.ts";
import {
  callUrl,
  resolveSource,
  sourceFromViewerArguments,
  transportsOf,
  type Access,
} from "./browser-access.ts";

type Cardd = Access;
type Transports = Readonly<Record<string, readonly string[]>>;

type View = OpResult<"browser.view">;

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));

async function post(cardd: Cardd, op: string, args: object): Promise<unknown> {
  const response = await fetch(callUrl(cardd.url), {
    method: "POST",
    headers: { authorization: `Bearer ${cardd.token}`, "content-type": "application/json" },
    body: JSON.stringify({ op, args }),
    signal: AbortSignal.timeout(15_000),
  });
  const outcome = check(HttpOutcomeSchema, await response.json());
  if (!outcome.ok) throw new Error(outcome.error);
  return outcome.value;
}

const callView = async (cardd: Cardd, captain: boolean): Promise<View> =>
  check(
    OPS["browser.view"].result,
    await post(cardd, "browser.view", {
      ...(captain ? { captain } : {}),
      ...(cardd.host === undefined ? {} : { host: cardd.host }),
    }),
  );

const callFrame = async (cardd: Cardd, target: string): Promise<Pulled> =>
  check(OPS["browser.frame"].result, await post(cardd, "browser.frame", { target }));

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

const digest = (text: string): Buffer => createHash("sha256").update(text).digest();

const json = (response: ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
};

class Viewer {
  private readonly cardd: Cardd;
  private readonly transports: Transports;
  private readonly captain: boolean;
  private readonly screens = new Map<string, { endpoint: string; screen: Screen }>();
  private browsers = new Map<string, string>();
  private own: string | null = null;
  private readonly poll = new Poll(
    (target) => callFrame(this.cardd, target),
    (target) => this.screenFor(target).size(target),
  );
  private allowed = new Set<string>();
  private cookie = "";
  private visible = new Map<string, string>();
  private readonly token: string;

  constructor(cardd: Cardd, transports: Transports, token: string, captain: boolean) {
    this.cardd = cardd;
    this.transports = transports;
    this.token = token;
    this.captain = captain;
  }

  close(): void {
    for (const { screen } of this.screens.values()) screen.close();
  }

  private screenOf(host: string): Screen {
    const known = this.screens.get(host);
    if (known !== undefined) return known.screen;
    const endpoint = this.browsers.get(host);
    if (endpoint === undefined) throw new Error(`no shared browser is configured on ${host}`);
    const via = host === this.own ? [] : this.transports[host];
    if (via === undefined)
      throw new Error(
        `no transport for ${host}: add it to hosts in config/lane.json of this lane, and set host there to this machine's name in the fleet`,
      );
    const made = new Screen(dial(via, endpoint));
    this.screens.set(host, { endpoint, screen: made });
    return made;
  }

  private screenFor(target: string): Screen {
    const host = this.visible.get(target);
    if (host === undefined) throw new Error("that tab is not listed for this viewer");
    return this.screenOf(host);
  }

  private knows(candidate: string | null | undefined): boolean {
    if (candidate === null || candidate === undefined) return false;
    return timingSafeEqual(digest(candidate), digest(this.token));
  }

  private cookieOf(request: IncomingMessage): string | undefined {
    const pairs = (request.headers.cookie ?? "").split(";").map((part) => part.trim());
    const mine = pairs.find((pair) => pair.startsWith(`${this.cookie}=`));
    return mine?.slice(this.cookie.length + 1);
  }

  allow(port: number): void {
    this.allowed = new Set([`127.0.0.1:${String(port)}`, `localhost:${String(port)}`]);
    this.cookie = `fleet_viewer_${String(port)}`;
  }

  private permits(request: IncomingMessage): boolean {
    const host = request.headers.host;
    if (host === undefined || !this.allowed.has(host)) return false;
    const origin = request.headers.origin;
    return origin === undefined || this.allowed.has(origin.replace(/^http:\/\//, ""));
  }

  private async shows(target: string): Promise<boolean> {
    if (!this.visible.has(target)) await this.listing();
    return this.visible.has(target);
  }

  private async listing(): Promise<View> {
    const view = await callView(this.cardd, this.captain);
    this.own = view.host;
    this.browsers = new Map(view.browsers.map(({ host, endpoint }) => [host, endpoint]));
    for (const [host, { endpoint, screen }] of this.screens) {
      if (this.browsers.get(host) === endpoint) continue;
      screen.close();
      this.screens.delete(host);
    }
    this.visible = new Map(view.tabs.map((tab) => [tab.target, tab.host]));
    return view;
  }

  private async stream(response: ServerResponse, target: string): Promise<void> {
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
    const send = (shown: Shown): void => {
      response.write(`data: ${JSON.stringify(shown)}\n\n`);
    };
    const watching: { stop: (() => void) | undefined } = { stop: undefined };
    response.on("close", () => {
      watching.stop?.();
    });
    watching.stop = this.captain
      ? await this.screenFor(target).watch(target, send, () => {
          response.end();
        })
      : this.poll.watch(target, send);
    if (response.destroyed) watching.stop();
  }

  private async route(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    if (url.pathname === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(VIEWER_PAGE);
    } else if (url.pathname === "/api/tabs") {
      const { tabs, problem } = await this.listing();
      json(response, 200, { tabs, problem });
    } else if (url.pathname === "/api/stream") {
      const target = url.searchParams.get("target") ?? "";
      if (await this.shows(target)) await this.stream(response, target);
      else response.writeHead(404).end();
    } else if (url.pathname === "/api/input" && request.method === "POST") {
      const input = check(InputSchema, JSON.parse(await readBody(request)));
      if (!(await this.shows(input.target))) response.writeHead(404).end();
      else {
        await this.screenFor(input.target).input(input);
        response.writeHead(204).end();
      }
    } else response.writeHead(404).end();
  }

  private enter(request: IncomingMessage, response: ServerResponse, url: URL): boolean {
    const offered = url.searchParams.get("t");
    if (this.knows(offered) && request.method === "GET" && url.pathname === "/") {
      url.searchParams.delete("t");
      response
        .writeHead(302, {
          location: `${url.pathname}${url.search}`,
          "set-cookie": `${this.cookie}=${this.token}; HttpOnly; SameSite=Strict; Path=/`,
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
  const flags = process.argv.slice(2);
  const token = randomBytes(24).toString("base64url");
  const captain = flags.includes("--captain");
  const source = sourceFromViewerArguments(flags);
  const viewer = new Viewer(await resolveSource(source), transportsOf(source), token, captain);
  const server = createServer((request, response) => {
    void viewer.answer(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address: AddressInfo | string | null = server.address();
  if (address === null || typeof address === "string") throw new Error("the viewer has no address");
  viewer.allow(address.port);
  const url = `http://127.0.0.1:${String(address.port)}/?t=${token}`;
  console.log(`Fleet browser viewer (${captain ? "captain" : "gated"}): ${url}`);
  if (flags.includes("--open") && process.env["FLEET_BROWSER_VIEW_OPEN"] !== "0") open(url);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      viewer.close();
      server.close();
      process.exit(0);
    });
  }
}

main().catch((error: unknown) => {
  console.error(reason(error));
  process.exit(1);
});
