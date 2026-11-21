import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import {
  CardViewSchema,
  check,
  HttpCallSchema,
  OPS,
  parseClientMessage,
  parseServerMessage,
  type Card,
} from "@fleet/protocol";
import { quote } from "@fleet/protocol/route";
import { WebSocket, WebSocketServer } from "ws";
import { begin, newCard, startFleet, type Fleet } from "./fleet.ts";
import { Harness, rawText, type Pi } from "./harness.ts";
import { HerdrLab } from "./herdr.ts";
import { records } from "./json.ts";
import { until } from "./live-fleet.ts";

const EXTENSION = fileURLToPath(new URL("../../packages/extension/src/index.ts", import.meta.url));

interface HeldPrepare {
  readonly reached: PromiseWithResolvers<string>;
  readonly release: Promise<undefined>;
}

export class JobLab {
  readonly fleet: Fleet;
  readonly h: Harness;
  readonly lab: HerdrLab;
  readonly card: Card;
  readonly env: Record<string, string>;
  readonly jobDir: string;

  private constructor(
    fleet: Fleet,
    h: Harness,
    lab: HerdrLab,
    card: Card,
    env: Record<string, string>,
  ) {
    this.fleet = fleet;
    this.h = h;
    this.lab = lab;
    this.card = card;
    this.env = env;
    this.jobDir = join(h.dir, "jobs");
    mkdirSync(this.jobDir);
    this.env["TMPDIR"] = this.jobDir;
  }

  static async start(): Promise<JobLab> {
    const fleet = await startFleet({ CARDD_TIMING_SCALE: "0.04" });
    const h = await Harness.start();
    const lab = await HerdrLab.start({});
    const created = await lab.run(["workspace", "create", "--no-focus"]);
    const [workspace] = records([created["workspace"]]).map((each) => each["workspace_id"]);
    if (typeof workspace !== "string") throw new Error("the lab returned no workspace");
    const card = await newCard(fleet.main, "Users see one scrollbar");
    const token = await begin(fleet.main, card, "run the tests");
    return new JobLab(fleet, h, lab, card, {
      FLEET_URL: fleet.cardd.url,
      FLEET_TOKEN: token,
      FLEET_ROLE: "worker",
      HERDR_SESSION: lab.name,
      HERDR_WORKSPACE_ID: workspace,
    });
  }

  async stop(t: Parameters<HerdrLab["printIfFailed"]>[0]): Promise<void> {
    await this.lab.printIfFailed(t);
    const stopped = await Promise.allSettled([
      this.lab.stop(),
      this.h.stop(),
      this.fleet.cardd.stop(),
    ]);
    const failed = stopped.find((result) => result.status === "rejected");
    if (failed !== undefined) throw new Error(`cleanup failed: ${String(failed.reason)}`);
  }

  worker(): Pi {
    return this.h.startPi("c-1-a1", this.env, [EXTENSION]);
  }

  async tabs() {
    const listed = await this.lab.run([
      "tab",
      "list",
      "--workspace",
      this.env["HERDR_WORKSPACE_ID"] ?? "",
    ]);
    return records(listed["tabs"]);
  }

  async hasTab(tab: string): Promise<boolean> {
    return (await this.tabs()).some((each) => each["tab_id"] === tab);
  }

  expireJob(): void {
    const db = new DatabaseSync(this.fleet.cardd.db, { timeout: 5000 });
    try {
      db.prepare("UPDATE jobs SET created_at = created_at - 60000 WHERE id = 1").run();
    } finally {
      db.close();
    }
  }

  wrapperPid(): unknown {
    const db = new DatabaseSync(this.fleet.cardd.db, { readOnly: true, timeout: 5000 });
    try {
      return db.prepare("SELECT wrapper_pid FROM jobs WHERE id = 1").get()?.["wrapper_pid"] ?? null;
    } finally {
      db.close();
    }
  }

  deliveredCount(): number {
    return this.h.events.filter((event) => event["type"] === "fleet_delivered").length;
  }

  async jobResults(): Promise<unknown[][]> {
    const view = check(CardViewSchema, await this.fleet.main.call("card", { card: this.card.id }));
    return view.entries
      .filter((entry) => entry.kind === "job-result")
      .map((entry) => [entry.fields["job"], entry.fields["exitCode"], entry.body]);
  }

  installShim(swallowKeys = false) {
    const bin = join(this.jobDir, "bin");
    mkdirSync(bin);
    const logs = {
      closes: join(this.jobDir, "tab-closes"),
      creates: join(this.jobDir, "tab-creates"),
      runs: join(this.jobDir, "pane-runs"),
      release: join(this.jobDir, "release-dispatch"),
    };
    const herdr = execFileSync("sh", ["-c", "command -v herdr"], { encoding: "utf8" }).trim();
    writeFileSync(
      join(bin, "herdr"),
      `#!/bin/sh
if [ "$1 $2" = 'tab close' ]; then
  echo "$3" >> ${quote(logs.closes)}
fi
if [ "$1 $2" = 'tab create' ]; then
  echo tab >> ${quote(logs.creates)}
fi
if [ "$1 $2" = 'pane send-keys' ] && ${swallowKeys ? "true" : "false"}; then
  exit 0
fi
if [ "$1 $2" = 'pane run' ]; then
  echo run >> ${quote(logs.runs)}
  exec ${quote(herdr)} pane run "$3" "while [ ! -e ${quote(logs.release)} ]; do sleep 0.05; done; $4"
fi
exec ${quote(herdr)} "$@"
`,
      { mode: 0o755 },
    );
    this.env["PATH"] = `${bin}:${process.env["PATH"] ?? ""}`;
    return logs;
  }

  async holdDispatch(t: TestContext, command: string, swallowKeys = false) {
    const proxy = await this.proxy(t);
    const shim = this.installShim(swallowKeys);
    this.h.onModel(() => ({ tool: "run_long", args: { label: "gate", command } }));
    this.h.onModel(() => ({ text: "waiting for the gate" }));
    const pi = this.worker();
    await until(
      () => (proxy.activities.includes("waiting") ? true : undefined),
      "the worker to publish waiting for the dispatched job",
    );
    const input = readdirSync(this.jobDir).find((name) => /^fleet-job-1-.+\.json$/.test(name));
    assert.ok(input);
    const launch = /^fleet-job-1-(.+)\.json$/.exec(input)?.[1];
    assert.ok(launch);
    const gate = (await this.tabs()).find((tab) => tab["label"] === "job-1-gate");
    assert.ok(gate);
    return {
      pi,
      proxy,
      shim,
      input: join(this.jobDir, input),
      launch,
      tab: String(gate["tab_id"]),
    };
  }

  private httpProxy(state: ProxyState) {
    return createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8").on("data", (chunk: string) => {
        body += chunk;
      });
      req.on("end", () => {
        void (async () => {
          const { op, args } = check(HttpCallSchema, JSON.parse(body));
          const fault = state.takeHttpFault(op);
          if (fault !== undefined) {
            if ("redirect" in fault) res.writeHead(307, { location: fault.redirect }).end();
            else
              res
                .writeHead(200, { "content-type": "application/json" })
                .end(JSON.stringify({ ok: true, value: fault.value }));
            return;
          }
          const result = await this.fleet.cardd.post(this.env["FLEET_TOKEN"] ?? "", op, args);
          const held = op === "job.prepare" ? state.takePrepare() : undefined;
          if (held !== undefined) {
            held.reached.resolve(check(OPS["job.prepare"].args, args).launch);
            await held.release;
          }
          res.writeHead(result.status, { "content-type": "application/json" });
          res.end(typeof result.body === "string" ? result.body : JSON.stringify(result.body));
        })().catch((error: unknown) => res.destroy(error instanceof Error ? error : undefined));
      });
    });
  }

  private sessionProxy(server: Server, state: ProxyState): WebSocketServer {
    const sockets = new WebSocketServer({ server });
    sockets.on("connection", (client) => {
      const upstream = new WebSocket(this.fleet.cardd.url);
      const ops = new Map<number, string>();
      state.clients.add(client);
      client.pause();
      upstream.on("open", () => client.resume());
      client.on("message", (raw) => {
        const text = rawText(raw);
        const message = parseClientMessage(text);
        if (message.t === "activity") state.activities.push(message.state);
        if (message.t === "call") ops.set(message.id, message.op);
        if (upstream.readyState === WebSocket.OPEN) upstream.send(text);
      });
      upstream.on("message", (raw) => {
        const text = rawText(raw);
        const message = parseServerMessage(text);
        const op = message.t === "result" ? ops.get(message.id) : undefined;
        if (message.t === "result") ops.delete(message.id);
        if (op === "jobs") state.lists += 1;
        const fault = op === undefined ? undefined : state.callFaults.get(op);
        const rewritten =
          message.t !== "result" || fault === undefined
            ? text
            : JSON.stringify(
                "error" in fault
                  ? { t: "result", id: message.id, ok: false, error: fault.error }
                  : { ...message, value: fault.value },
              );
        if (client.readyState === WebSocket.OPEN) client.send(rewritten);
      });
      upstream.on("error", () => client.terminate());
      upstream.on("close", () => client.terminate());
      client.on("error", () => upstream.terminate());
      client.on("close", () => upstream.terminate());
    });
    return sockets;
  }

  async proxy(t: TestContext) {
    const state = new ProxyState();
    const server = this.httpProxy(state);
    const sockets = this.sessionProxy(server, state);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    this.env["FLEET_URL"] = `ws://127.0.0.1:${String(address.port)}/session`;
    const drop = (): void => {
      for (const client of state.clients) client.terminate();
    };
    t.after(() => {
      drop();
      sockets.close();
      server.closeAllConnections();
      server.close();
    });
    return {
      activities: state.activities,
      lists: (): number => state.lists,
      drop,
      callFault: (op: string, fault: CallFault | undefined): void => {
        if (fault === undefined) state.callFaults.delete(op);
        else state.callFaults.set(op, fault);
      },
      httpFault: (op: string, fault: HttpFault, times: number): void => {
        state.httpFaults.set(op, { fault, times });
      },
      holdPrepare: () => {
        const reached = Promise.withResolvers<string>();
        const release = Promise.withResolvers<undefined>();
        t.after(() => release.resolve(undefined));
        state.prepare = { reached, release: release.promise };
        return { reached: reached.promise, release: () => release.resolve(undefined) };
      },
      push: (id: number, fields: Record<string, unknown>): void => {
        const message = JSON.stringify({
          t: "entry",
          entry: {
            id,
            card: this.card.id,
            author: "job:1",
            kind: "job-result",
            body: "could not start: injected fence",
            fields: { label: "gate", ...fields },
            createdAt: Date.now(),
          },
          name: "users-see-one-scrollbar",
          mode: "followUp",
        });
        for (const client of state.clients)
          if (client.readyState === WebSocket.OPEN) client.send(message);
      },
    };
  }
}

type CallFault = { value: unknown } | { error: string };
type HttpFault = { redirect: string } | { value: unknown };

class ProxyState {
  readonly clients = new Set<WebSocket>();
  readonly activities: string[] = [];
  readonly callFaults = new Map<string, CallFault>();
  readonly httpFaults = new Map<string, { fault: HttpFault; times: number }>();
  prepare: HeldPrepare | undefined;
  lists = 0;

  takePrepare(): HeldPrepare | undefined {
    const held = this.prepare;
    this.prepare = undefined;
    return held;
  }

  takeHttpFault(op: string): HttpFault | undefined {
    const entry = this.httpFaults.get(op);
    if (entry === undefined || entry.times <= 0) return undefined;
    entry.times -= 1;
    return entry.fault;
  }
}
