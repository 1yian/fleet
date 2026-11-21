import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
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

  installShim() {
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

  async holdDispatch(t: TestContext, command: string) {
    const proxy = await this.proxy(t);
    const shim = this.installShim();
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

  private httpProxy(takePrepare: () => HeldPrepare | undefined) {
    return createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8").on("data", (chunk: string) => {
        body += chunk;
      });
      req.on("end", () => {
        void (async () => {
          const { op, args } = check(HttpCallSchema, JSON.parse(body));
          const result = await this.fleet.cardd.post(this.env["FLEET_TOKEN"] ?? "", op, args);
          const held = op === "job.prepare" ? takePrepare() : undefined;
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

  async proxy(t: TestContext) {
    const clients = new Set<WebSocket>();
    const activities: string[] = [];
    let lists = 0;
    let prepare: HeldPrepare | undefined;
    let stopReply: unknown;
    const server = this.httpProxy(() => {
      const held = prepare;
      prepare = undefined;
      return held;
    });
    const sockets = new WebSocketServer({ server });
    sockets.on("connection", (client) => {
      const upstream = new WebSocket(this.fleet.cardd.url);
      const listReads = new Set<number>();
      const stopReads = new Set<number>();
      clients.add(client);
      client.pause();
      upstream.on("open", () => client.resume());
      client.on("message", (raw) => {
        const text = rawText(raw);
        const message = parseClientMessage(text);
        if (message.t === "activity") activities.push(message.state);
        if (message.t === "call" && message.op === "jobs") listReads.add(message.id);
        if (message.t === "call" && message.op === "job.stop") stopReads.add(message.id);
        if (upstream.readyState === WebSocket.OPEN) upstream.send(text);
      });
      upstream.on("message", (raw) => {
        const text = rawText(raw);
        const message = parseServerMessage(text);
        const rewritten =
          message.t === "result" && stopReads.delete(message.id) && stopReply !== undefined
            ? JSON.stringify({ ...message, value: stopReply })
            : text;
        if (client.readyState === WebSocket.OPEN) client.send(rewritten);
        if (message.t === "result" && listReads.delete(message.id)) lists += 1;
      });
      upstream.on("error", () => client.terminate());
      upstream.on("close", () => client.terminate());
      client.on("error", () => upstream.terminate());
      client.on("close", () => upstream.terminate());
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    this.env["FLEET_URL"] = `ws://127.0.0.1:${String(address.port)}/session`;
    const drop = (): void => {
      for (const client of clients) client.terminate();
    };
    t.after(() => {
      drop();
      sockets.close();
      server.closeAllConnections();
      server.close();
    });
    return {
      activities,
      lists: (): number => lists,
      drop,
      rewriteStop: (value: unknown): void => {
        stopReply = value;
      },
      holdPrepare: () => {
        const reached = Promise.withResolvers<string>();
        const release = Promise.withResolvers<undefined>();
        t.after(() => release.resolve(undefined));
        prepare = { reached, release: release.promise };
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
        for (const client of clients)
          if (client.readyState === WebSocket.OPEN) client.send(message);
      },
    };
  }
}
