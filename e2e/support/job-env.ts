import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import {
  CardViewSchema,
  check,
  HttpCallSchema,
  HttpOutcomeSchema,
  OPS,
  parseClientMessage,
  parseServerMessage,
  type Card,
  type ClientMessage,
  type ServerMessage,
} from "@fleet/protocol";
import { WebSocket, WebSocketServer } from "ws";
import type { Fleet } from "./fleet.ts";
import { rawText, type Harness, type Pi, type Turn } from "./harness.ts";
import type { HerdrLab } from "./herdr.ts";
import { records } from "./json.ts";
import { until as untilAsync } from "./live-fleet.ts";

const EXTENSION = fileURLToPath(new URL("../../packages/extension/src/index.ts", import.meta.url));

export interface JobState {
  readonly fleet: Fleet;
  readonly h: Harness;
  readonly lab: HerdrLab;
  readonly env: Record<string, string>;
  readonly jobDir: string;
  readonly card: Card;
}

export type CallResult = Extract<ServerMessage, { t: "result" }>;

export type Call = (
  op: string,
  args: unknown,
) => Promise<{ status: number; body: unknown; close?: boolean }>;
type Answer = (reply: CallResult, send: (reply: CallResult) => void) => CallResult | undefined;

export const lastUser = (turns: Turn[]): string | undefined =>
  turns.findLast((turn) => turn.role === "user")?.text;

export const paneTail = (reply: "intact" | "unreadable"): string =>
  reply === "intact"
    ? `printf '%s\\n' "$response"\n  exit 0`
    : `echo 'pane reply unavailable' >&2\n  exit 1`;

export async function until<T>(read: () => T | undefined, what: string): Promise<T> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

export function withinMs<T>(work: Promise<T>, ms: number): Promise<T> {
  const abort = AbortSignal.timeout(ms);
  const deadline = new Promise<never>((_resolve, reject) => {
    abort.addEventListener(
      "abort",
      () => {
        reject(abort.reason instanceof Error ? abort.reason : new Error(String(abort.reason)));
      },
      { once: true },
    );
  });
  return Promise.race([work, deadline]);
}

export function pids(text: string): number[] {
  try {
    return execFileSync("pgrep", ["-f", text], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean)
      .map(Number);
  } catch {
    return [];
  }
}

export function readJobList(body: unknown) {
  const outcome = check(HttpOutcomeSchema, body);
  if (!outcome.ok) throw new Error(outcome.error);
  return check(OPS.jobs.result, outcome.value);
}

export function jobHelpers(current: () => JobState) {
  const worker = (): Pi => current().h.startPi("c-1-a1", current().env, [EXTENSION]);
  const said = (text: string): boolean =>
    current().h.calls.some((turns) => turns.some((turn) => turn.text.includes(text)));
  const settled = (n: number) =>
    current().h.waitForNth((e) => e["type"] === "settled", n, `settle ${String(n)}`);
  const callCardd = (op: string, args: unknown) =>
    current().fleet.cardd.post(current().env["FLEET_TOKEN"] ?? "", op, args);
  const workspace = (): string => current().env["HERDR_WORKSPACE_ID"] ?? "";
  const tabsInWorkspace = async () =>
    records((await current().lab.run(["tab", "list", "--workspace", workspace()]))["tabs"]);
  const cardView = async () =>
    check(CardViewSchema, await current().fleet.main.call("card", { card: current().card.id }));
  const findings = (): string[] =>
    current()
      .fleet.main.entries.filter(({ entry }) => entry.kind === "finding")
      .map(({ entry }) => entry.body);
  const commandAwaitingGo = (n: number): { command: string; ready: string; go: string } => {
    const ready = join(current().h.dir, `ready-${String(n)}`);
    const go = join(current().h.dir, `go-${String(n)}`);
    const command = `touch ${ready}; while [ ! -f ${go} ]; do sleep 0.1; done; echo late`;
    return { command, ready, go };
  };
  const wrapperOf = async (job: number, ready: string): Promise<number> => {
    await until(() => (existsSync(ready) ? true : undefined), "the job to start");
    const [wrapper] = pids(join(current().jobDir, `fleet-job-${String(job)}-`));
    assert.ok(wrapper !== undefined);
    return wrapper;
  };
  const shim = (script: (herdr: string) => string): void => {
    const { jobDir, env } = current();
    const bin = join(jobDir, "bin");
    mkdirSync(bin);
    const herdr = execFileSync("sh", ["-c", "command -v herdr"], { encoding: "utf8" }).trim();
    writeFileSync(join(bin, "herdr"), script(herdr), { mode: 0o755 });
    env["PATH"] = `${bin}:${process.env["PATH"] ?? ""}`;
  };
  const waitTabGone = (value: string, key: "label" | "tab_id" = "label") =>
    untilAsync(
      async () => ((await tabsInWorkspace()).some((tab) => tab[key] === value) ? undefined : true),
      `tab ${value} to close`,
    );
  const jobResults = async () =>
    (await cardView()).entries
      .filter((entry) => entry.kind === "job-result")
      .map((entry) => [entry.fields["job"], entry.fields["exitCode"], entry.body]);
  const cardReports = async () =>
    (await cardView()).entries
      .filter((entry) => entry.kind === "report")
      .map((entry) => [entry.fields["status"], entry.body]);
  return {
    worker,
    said,
    settled,
    callCardd,
    workspace,
    tabsInWorkspace,
    cardView,
    jobResults,
    cardReports,
    waitTabGone,
    findings,
    commandAwaitingGo,
    wrapperOf,
    shim,
  };
}

export function serveCalls(call: Call): ReturnType<typeof createServer> {
  return createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8").on("data", (chunk: string) => {
      body += chunk;
    });
    req.on("end", () => {
      void (async () => {
        const { op, args } = check(HttpCallSchema, JSON.parse(body));
        const result = await call(op, args);
        res.writeHead(result.status, {
          "content-type": "application/json",
          ...(result.close === true ? { connection: "close" } : {}),
        });
        res.end(typeof result.body === "string" ? result.body : JSON.stringify(result.body));
      })().catch((error: unknown) => res.destroy(error instanceof Error ? error : undefined));
    });
  });
}

export function pairSockets(client: WebSocket, upstream: WebSocket): void {
  upstream.on("error", () => {
    client.terminate();
  });
  upstream.on("close", () => {
    client.terminate();
  });
  client.on("error", () => {
    upstream.terminate();
  });
  client.on("close", () => {
    upstream.terminate();
  });
}

interface Interceptor {
  readonly op: string;
  readonly reads: Set<number>;
  readonly answer: Answer | undefined;
}

interface Held {
  readonly id: number;
  readonly release: Promise<void>;
}

interface ProxyHooks {
  readonly interceptors: Interceptor[];
  readonly beforeStop: Promise<void> | undefined;
  readonly outbound: ((message: ClientMessage) => void) | undefined;
  readonly holdOn: (fields: Record<string, unknown>) => boolean;
  readonly holdAcrossReconnect: boolean;
}

interface HoldState {
  next: boolean | Promise<void>;
  replay: Held | undefined;
}

function relayCalls(client: WebSocket, upstream: WebSocket, hooks: ProxyHooks): void {
  const { interceptors, beforeStop, outbound } = hooks;
  const watching =
    interceptors.some(({ answer }) => answer !== undefined) ||
    beforeStop !== undefined ||
    outbound !== undefined;
  client.on("message", (raw) => {
    const text = rawText(raw);
    const forward = (): void => {
      if (upstream.readyState === WebSocket.OPEN) upstream.send(text);
    };
    if (watching) {
      const message = parseClientMessage(text);
      outbound?.(message);
      if (message.t === "call") {
        interceptors
          .find(({ op, answer }) => op === message.op && answer !== undefined)
          ?.reads.add(message.id);
        if (message.op === "job.stop" && beforeStop !== undefined) {
          void beforeStop.then(forward);
          return;
        }
      }
    }
    forward();
  });
}

type ServerEvent = ReturnType<typeof parseServerMessage>;

function startHold(
  client: WebSocket,
  message: ServerEvent,
  hooks: ProxyHooks,
  hold: HoldState,
): Held | "terminated" | undefined {
  if (!hold.next || message.t !== "entry" || !hooks.holdOn(message.entry.fields)) return undefined;
  const release = hold.next;
  hold.next = false;
  if (release === true) {
    client.terminate();
    return "terminated";
  }
  const held = { id: message.entry.id, release };
  if (hooks.holdAcrossReconnect) hold.replay = held;
  return held;
}

function answerOrForward(
  client: WebSocket,
  message: ServerEvent,
  text: string,
  hooks: ProxyHooks,
): void {
  if (client.readyState !== WebSocket.OPEN) return;
  const send = (reply: CallResult): void => {
    if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(reply));
  };
  const hit =
    message.t === "result"
      ? hooks.interceptors.find((each) => each.reads.delete(message.id))
      : undefined;
  if (message.t !== "result" || hit === undefined) client.send(text);
  else {
    const reply = hit.answer?.(message, send);
    if (reply !== undefined) send(reply);
  }
}

function relayReplies(
  client: WebSocket,
  upstream: WebSocket,
  hooks: ProxyHooks,
  hold: HoldState,
): void {
  let heldOnSocket: Held | undefined;
  upstream.on("message", (raw) => {
    const text = rawText(raw);
    const message = parseServerMessage(text);
    const started = startHold(client, message, hooks, hold);
    if (started === "terminated") return;
    if (started !== undefined && !hooks.holdAcrossReconnect) heldOnSocket = started;
    const held = heldOnSocket ?? hold.replay;
    if (held !== undefined && message.t === "entry" && message.entry.id === held.id) {
      void held.release.then(() => {
        if (client.readyState === WebSocket.OPEN) client.send(text);
      });
      return;
    }
    answerOrForward(client, message, text, hooks);
  });
}

const forwardOnly = (answer: ((reply: CallResult) => CallResult | undefined) | undefined) =>
  answer && ((reply: CallResult) => answer(reply));

export function makeJobProxy(current: () => JobState) {
  return async function jobProxy(
    t: TestContext,
    call: Call,
    dropFence: boolean | Promise<void> = false,
    jobsReply?: Answer,
    reportReply?: (reply: CallResult) => CallResult | undefined,
    beforeStop?: Promise<void>,
    idleReply?: (reply: CallResult) => CallResult | undefined,
    outbound?: (message: ClientMessage) => void,
    exactReply?: (reply: CallResult) => CallResult | undefined,
    holdOn: (fields: Record<string, unknown>) => boolean = (fields) =>
      fields["startupFenced"] === true || fields["lost"] === true,
    holdAcrossReconnect = false,
  ) {
    const proxy = serveCalls(call);
    const sockets = new WebSocketServer({ server: proxy });
    const hold: HoldState = { next: dropFence, replay: undefined };
    const disconnect = (): void => {
      for (const client of sockets.clients) client.terminate();
    };
    sockets.on("connection", (client) => {
      const upstream = new WebSocket(current().fleet.cardd.url);
      const hooks: ProxyHooks = {
        interceptors: [
          { op: "jobs", reads: new Set(), answer: jobsReply },
          { op: "job.running", reads: new Set(), answer: forwardOnly(exactReply) },
          { op: "job.idle", reads: new Set(), answer: forwardOnly(idleReply) },
          { op: "report", reads: new Set(), answer: forwardOnly(reportReply) },
        ],
        beforeStop,
        outbound,
        holdOn,
        holdAcrossReconnect,
      };
      client.pause();
      upstream.on("open", () => {
        client.resume();
      });
      relayCalls(client, upstream, hooks);
      relayReplies(client, upstream, hooks, hold);
      pairSockets(client, upstream);
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    t.after(() => {
      disconnect();
      sockets.close();
      proxy.closeAllConnections();
      proxy.close();
    });
    const address = proxy.address();
    assert.ok(address && typeof address !== "string");
    current().env["FLEET_URL"] = `ws://127.0.0.1:${String(address.port)}/session`;
    return disconnect;
  };
}
