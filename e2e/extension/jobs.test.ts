import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test, type TestContext } from "node:test";
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
import { quote } from "@fleet/protocol/route";
import { WebSocket, WebSocketServer } from "ws";
import { begin, newCard, startFleet, status, type Fleet } from "../support/fleet.ts";
import { Harness, rawText, type Pi, type Turn } from "../support/harness.ts";
import { HerdrLab } from "../support/herdr.ts";
import { records } from "../support/json.ts";
import { until as untilAsync } from "../support/live-fleet.ts";

const EXTENSION = fileURLToPath(new URL("../../packages/extension/src/index.ts", import.meta.url));

let fleet: Fleet;
let h: Harness;
let lab: HerdrLab;
let env: Record<string, string>;
let jobDir: string;
let card: Card;
beforeEach(async () => {
  fleet = await startFleet({ CARDD_TIMING_SCALE: "0.04" });
  h = await Harness.start();
  lab = await HerdrLab.start({});
  const created = await lab.run(["workspace", "create", "--no-focus"]);
  const [workspace] = records([created["workspace"]]).map((each) => each["workspace_id"]);
  if (typeof workspace !== "string") throw new Error("the lab returned no workspace");
  card = await newCard(fleet.main, "Users see one scrollbar");
  const token = await begin(fleet.main, card, "run the tests");
  env = { FLEET_URL: fleet.cardd.url, FLEET_TOKEN: token, FLEET_ROLE: "worker" };
  jobDir = join(h.dir, "jobs");
  mkdirSync(jobDir);
  env = { ...env, HERDR_SESSION: lab.name, HERDR_WORKSPACE_ID: workspace, TMPDIR: jobDir };
});
afterEach(async (t) => {
  await lab.printIfFailed(t);
  const stopped = await Promise.allSettled([lab.stop(), h.stop(), fleet.cardd.stop()]);
  const failed = stopped.find((result) => result.status === "rejected");
  if (failed !== undefined) throw new Error(`cleanup failed: ${String(failed.reason)}`);
});

const worker = (): Pi => h.startPi("c-1-a1", env, [EXTENSION]);
const lastUser = (turns: Turn[]): string | undefined =>
  turns.findLast((turn) => turn.role === "user")?.text;
const said = (text: string): boolean =>
  h.calls.some((turns) => turns.some((turn) => turn.text.includes(text)));
const paneTail = (reply: "intact" | "unreadable"): string =>
  reply === "intact"
    ? `printf '%s\\n' "$response"\n  exit 0`
    : `echo 'pane reply unavailable' >&2\n  exit 1`;
const settled = (n: number) =>
  h.waitForNth((e) => e["type"] === "settled", n, `settle ${String(n)}`);

test("a failed pipeline wakes the worker with failure, and the wait is not a stall", async () => {
  h.onModel(() => ({
    tool: "run_long",
    args: { label: "tests", command: "(echo one; echo two; exit 3) | tail -n 2" },
  }));
  h.onModel(() => ({ text: "waiting for the tests" }));
  h.onModel(() => ({ tool: "report", args: { status: "failed", text: "two tests fail" } }));
  worker();
  await fleet.main.waitForEntries(1);

  assert.equal(
    lastUser(await h.waitForCall(2)),
    "[fleet] c-1 users-see-one-scrollbar job 1 (tests) exited 3: one\ntwo",
  );
  assert.ok(said("job 1 (tests) in tab job-1-tests"));
  assert.equal(said("Your run is ending without a handoff"), false);
  assert.deepEqual(
    fleet.main.entries.map(({ entry }) => [entry.fields["status"], entry.body]),
    [["failed", "two tests fail"]],
  );
  const labels = async (): Promise<unknown[]> =>
    records(
      (await lab.run(["tab", "list", "--workspace", env["HERDR_WORKSPACE_ID"] ?? ""]))["tabs"],
    ).map((tab) => tab["label"]);
  const deadline = Date.now() + 10_000;
  while ((await labels()).includes("job-1-tests") && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(await labels(), ["1"]);
});

type CallResult = Extract<ServerMessage, { t: "result" }>;

async function jobProxy(
  t: TestContext,
  call: (op: string, args: unknown) => Promise<{ status: number; body: unknown; close?: boolean }>,
  dropFence: boolean | Promise<void> = false,
  jobsReply?: (reply: CallResult) => CallResult | undefined,
  reportReply?: (reply: CallResult) => CallResult | undefined,
  beforeStop?: Promise<void>,
  idleReply?: (reply: CallResult) => CallResult | undefined,
  outbound?: (message: ClientMessage) => void,
) {
  const proxy = createServer((req, res) => {
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
  const sockets = new WebSocketServer({ server: proxy });
  const disconnect = (): void => {
    for (const client of sockets.clients) client.terminate();
  };
  sockets.on("connection", (client) => {
    const upstream = new WebSocket(fleet.cardd.url);
    const jobReads = new Set<number>();
    const reports = new Set<number>();
    const idleReads = new Set<number>();
    let held: { id: number; release: true | Promise<void> } | undefined;
    client.pause();
    upstream.on("open", () => {
      client.resume();
    });
    client.on("message", (raw) => {
      const text = rawText(raw);
      const forward = (): void => {
        if (upstream.readyState === WebSocket.OPEN) upstream.send(text);
      };
      if (
        jobsReply !== undefined ||
        reportReply !== undefined ||
        beforeStop !== undefined ||
        idleReply !== undefined ||
        outbound !== undefined
      ) {
        const message = parseClientMessage(text);
        outbound?.(message);
        if (message.t === "call") {
          if (message.op === "job.idle" && idleReply !== undefined) idleReads.add(message.id);
          if (message.op === "jobs" && jobsReply !== undefined) jobReads.add(message.id);
          if (message.op === "report" && reportReply !== undefined) reports.add(message.id);
          if (message.op === "job.stop" && beforeStop !== undefined) {
            void beforeStop.then(forward);
            return;
          }
        }
      }
      forward();
    });
    upstream.on("message", (raw) => {
      const text = rawText(raw);
      const message = parseServerMessage(text);
      if (
        held === undefined &&
        dropFence &&
        message.t === "entry" &&
        (message.entry.fields["startupFenced"] === true || message.entry.fields["lost"] === true)
      ) {
        held = { id: message.entry.id, release: dropFence };
        dropFence = false;
      }
      if (held !== undefined && message.t === "entry" && message.entry.id === held.id) {
        if (held.release === true) client.terminate();
        else
          void held.release.then(() => {
            if (client.readyState === WebSocket.OPEN) client.send(text);
          });
      } else if (client.readyState === WebSocket.OPEN) {
        if (message.t === "result" && jobReads.delete(message.id) && jobsReply !== undefined) {
          const reply = jobsReply(message);
          if (reply !== undefined) client.send(JSON.stringify(reply));
        } else if (
          message.t === "result" &&
          idleReads.delete(message.id) &&
          idleReply !== undefined
        ) {
          const reply = idleReply(message);
          if (reply !== undefined) client.send(JSON.stringify(reply));
        } else if (
          message.t === "result" &&
          reports.delete(message.id) &&
          reportReply !== undefined
        ) {
          const reply = reportReply(message);
          if (reply !== undefined) client.send(JSON.stringify(reply));
        } else client.send(text);
      }
    });
    upstream.on("error", () => client.terminate());
    upstream.on("close", () => client.terminate());
    client.on("error", () => upstream.terminate());
    client.on("close", () => upstream.terminate());
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
  env["FLEET_URL"] = `ws://127.0.0.1:${String(address.port)}/session`;
  return disconnect;
}

const callCardd = (op: string, args: unknown) =>
  fleet.cardd.post(env["FLEET_TOKEN"] ?? "", op, args);

const workspace = (): string => env["HERDR_WORKSPACE_ID"] ?? "";
const tabsInWorkspace = async () =>
  records((await lab.run(["tab", "list", "--workspace", workspace()]))["tabs"]);

const cardView = async () =>
  check(CardViewSchema, await fleet.main.call("card", { card: card.id }));
const jobResults = async () =>
  (await cardView()).entries
    .filter((entry) => entry.kind === "job-result")
    .map((entry) => [entry.fields["job"], entry.fields["exitCode"], entry.body]);
const cardReports = async () =>
  (await cardView()).entries
    .filter((entry) => entry.kind === "report")
    .map((entry) => [entry.fields["status"], entry.body]);

test("run_long recovers a committed reservation after torn prepare replies and runs once", async (t) => {
  const receipts: number[] = [];
  await jobProxy(t, async (op, args) => {
    const result = await callCardd(op, args);
    const outcome = check(HttpOutcomeSchema, result.body);
    if (op === "job.prepare" && outcome.ok) {
      receipts.push(check(OPS["job.prepare"].result, outcome.value).job);
      if (receipts.length === 1) return { ...result, body: '{"ok":true,"value":' };
      if (receipts.length === 2)
        return { ...result, body: { ok: true, value: { job: receipts[1] } } };
    }
    return result;
  });

  const marker = join(jobDir, "executions");
  h.onModel(() => ({
    tool: "run_long",
    args: { label: "recover", command: `echo executed >> ${quote(marker)}; echo recovered` },
  }));
  h.onModel(() => ({ text: "waiting for the command" }));
  h.onModel(() => ({ tool: "report", args: { status: "done", text: "result received" } }));
  worker();
  await h.waitForCall(2);
  assert.ok(said("job 1 (recover) in tab job-1-recover"));
  await fleet.main.waitForEntry((entry) => entry.body === "result received", "the worker handoff");
  assert.deepEqual(receipts, [1, 1, 1]);
  assert.equal(readFileSync(marker, "utf8"), "executed\n");
  assert.deepEqual(await jobResults(), [[1, 0, "recovered"]]);
  const db = new DatabaseSync(fleet.cardd.db, { readOnly: true, timeout: 5000 });
  t.after(() => db.close());
  const reservations = db.prepare("SELECT id FROM jobs WHERE label = ?").all("recover");
  assert.deepEqual(
    reservations.map((row) => row["id"]),
    [1],
  );
});

test("run_long retries transient HTTP 400 writes with the same prepare and registration identity", async (t) => {
  const db = new DatabaseSync(fleet.cardd.db, { timeout: 5000 });
  t.after(() => db.close());
  db.exec(`CREATE TRIGGER refuse_prepare BEFORE INSERT ON jobs WHEN NEW.label = 'recover-writes'
    BEGIN SELECT RAISE(ABORT, 'injected prepare write failure'); END;
    CREATE TRIGGER refuse_registration BEFORE UPDATE OF wrapper_pid ON jobs WHEN OLD.label = 'recover-writes'
    BEGIN SELECT RAISE(ABORT, 'injected registration write failure'); END;`);
  const prepares: unknown[] = [];
  const registrations: unknown[] = [];
  const refusals: { op: string; status: number }[] = [];
  await jobProxy(t, async (op, args) => {
    const result = await callCardd(op, args);
    if (op !== "job.prepare" && op !== "job.register") return result;
    const calls = op === "job.prepare" ? prepares : registrations;
    calls.push(args);
    if (calls.length === 1) {
      refusals.push({ op, status: result.status });
      db.exec(
        op === "job.prepare" ? "DROP TRIGGER refuse_prepare" : "DROP TRIGGER refuse_registration",
      );
    }
    return result;
  });
  const marker = join(jobDir, "executions");
  h.onModel(() => ({
    tool: "run_long",
    args: { label: "recover-writes", command: `echo executed >> ${quote(marker)}; echo recovered` },
  }));
  h.onModel(() => ({ text: "Waiting for the recovered command" }));
  h.onModel(() => ({ tool: "report", args: { status: "done", text: "Write retries verified" } }));
  worker();
  await h.waitForCall(2);
  assert.ok(said("job 1 (recover-writes) in tab"));
  await h.waitForNth((event) => event["type"] === "fleet_delivered", 2, "the recovered job result");
  assert.deepEqual(refusals, [
    { op: "job.prepare", status: 400 },
    { op: "job.register", status: 400 },
  ]);
  for (const calls of [prepares, registrations]) {
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0], calls[1]);
  }
  assert.equal(db.prepare("SELECT count(*) AS count FROM jobs").get()?.["count"], 1);
  assert.equal(readFileSync(marker, "utf8"), "executed\n");
  assert.deepEqual(await jobResults(), [[1, 0, "recovered"]]);
});

for (const torn of [true, false]) {
  test(`an expired reservation cannot dispatch after ${torn ? "a torn prepare reply and replay" : "a stale prepare receipt"}`, async (t) => {
    const release = Promise.withResolvers<void>();
    t.after(() => release.resolve());
    const db = new DatabaseSync(fleet.cardd.db, { timeout: 5000 });
    t.after(() => db.close());
    const receipts: unknown[] = [];
    const marker = join(jobDir, "ran-after-fence");
    await jobProxy(t, async (op, args) => {
      const result = await callCardd(op, args);
      if (op !== "job.prepare") return result;
      const outcome = check(HttpOutcomeSchema, result.body);
      assert.ok(outcome.ok);
      const receipt = check(OPS["job.prepare"].result, outcome.value);
      receipts.push(receipt);
      if (receipts.length !== 1) return result;
      db.prepare("UPDATE jobs SET created_at = created_at - 60000 WHERE id = ?").run(receipt.job);
      await release.promise;
      return torn ? { ...result, body: '{"ok":true,"value":' } : result;
    });
    h.onModel(() => ({
      tool: "run_long",
      args: { label: "expired", command: `touch ${quote(marker)}` },
    }));
    h.onModel(() => ({ tool: "report", args: { status: "done", text: "Expiry observed" } }));
    const initialTabs = await tabsInWorkspace();
    worker();
    await h.waitForNth((event) => event["type"] === "fleet_delivered", 2, "the early fence");
    assert.deepEqual(await tabsInWorkspace(), initialTabs);
    release.resolve();
    await h.waitForCall(2);
    assert.ok(said("Job 1 cannot start:"));
    assert.equal(said("Started job 1"), false);
    assert.equal(receipts.length, torn ? 2 : 1);
    if (torn)
      assert.deepEqual(receipts[1], {
        job: 1,
        unavailable:
          "already finished: could not start: wrapper did not register before the startup deadline",
      });
    assert.deepEqual(
      (await tabsInWorkspace()).map((tab) => tab["tab_id"]),
      initialTabs.map((tab) => tab["tab_id"]),
    );
    assert.equal(existsSync(marker), false);
    assert.deepEqual(await jobResults(), [
      [1, 127, "could not start: wrapper did not register before the startup deadline"],
    ]);
  });
}

for (const registrationFirst of [false, true]) {
  test(`stop_job ${registrationFirst ? "signals the pinned wrapper" : "fences the reservation"} while registration is in flight`, async (t) => {
    const waiting = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    t.after(() => release.resolve());
    const registered = Promise.withResolvers<boolean>();
    const disconnect = await jobProxy(t, async (op, args) => {
      if (op !== "job.register") return callCardd(op, args);
      if (!registrationFirst) {
        waiting.resolve();
        await release.promise;
      }
      const result = await callCardd(op, args);
      const outcome = check(HttpOutcomeSchema, result.body);
      assert.ok(outcome.ok);
      registered.resolve(check(OPS["job.register"].result, outcome.value).registered);
      if (registrationFirst) {
        waiting.resolve();
        await release.promise;
      }
      return result;
    });
    let decoy: unknown;
    if (registrationFirst) {
      await lab.run([
        "tab",
        "create",
        "--workspace",
        workspace(),
        "--label",
        "job-1-stopping",
        "--no-focus",
      ]);
      decoy = (await tabsInWorkspace()).find((tab) => tab["label"] === "job-1-stopping")?.[
        "tab_id"
      ];
      assert.equal(typeof decoy, "string");
    }
    const marker = join(jobDir, "unexpected-execution");
    h.onModel(() => ({
      tool: "run_long",
      args: { label: "stopping", command: `touch ${quote(marker)}` },
    }));
    h.onModel(async () => {
      await waiting.promise;
      if (registrationFirst) {
        disconnect();
        await h.waitForNth(
          (event) => event["type"] === "fleet_connected",
          2,
          "the worker to resync running jobs",
        );
      }
      return { tool: "stop_job", args: { job: 1 } };
    });
    h.onModel(() => ({ text: "Stop requested" }));
    h.onModel(() => ({ tool: "report", args: { status: "done", text: "Stop verified" } }));
    worker();
    await h.waitForCall(2);
    assert.ok(said(registrationFirst ? "Sent a stop to job 1" : "Its command will not run"));
    if (!registrationFirst) {
      await waitTabGone("job-1-stopping");
    }
    release.resolve();
    assert.equal(await registered.promise, registrationFirst);
    const output = registrationFirst ? "interrupted" : "stopped before wrapper registration";
    await h.waitForNth((event) => event["type"] === "fleet_delivered", 2, "the job result");
    assert.deepEqual(await jobResults(), [[1, 130, output]]);
    assert.equal(existsSync(marker), false);
    if (registrationFirst)
      assert.ok((await tabsInWorkspace()).some((tab) => tab["tab_id"] === decoy));
  });
}

const waitTabGone = (value: string, key: "label" | "tab_id" = "label") =>
  untilAsync(
    async () => ((await tabsInWorkspace()).some((tab) => tab[key] === value) ? undefined : true),
    `tab ${value} to close`,
  );

for (const dropFence of [false, true])
  test(`cardd fences ambiguous startup after failed writes ${dropFence ? "and replays after reconnect" : "without reconnecting"}`, async (t) => {
    await jobProxy(t, callCardd, dropFence);
    const bin = join(jobDir, "bin");
    mkdirSync(bin);
    const dispatches = join(jobDir, "dispatches");
    const closes = join(jobDir, "closes");
    const marker = join(jobDir, "unexpected-execution");
    const herdr = execFileSync("sh", ["-c", "command -v herdr"], { encoding: "utf8" }).trim();
    writeFileSync(
      join(bin, "herdr"),
      `#!/bin/sh
if [ "$1 $2" = 'pane run' ]; then
  echo dispatch >> ${quote(dispatches)}
  echo 'pane reply unavailable' >&2
  exit 1
fi
if [ "$1 $2" = 'tab close' ]; then
  if [ ! -e ${quote(closes)} ]; then
    printf '%s\u005cn' "$3" >> ${quote(closes)}
    echo 'injected transient tab close failure' >&2
    exit 1
  fi
  printf '%s\u005cn' "$3" >> ${quote(closes)}
fi
exec ${quote(herdr)} "$@"
`,
      { mode: 0o755 },
    );
    env["PATH"] = `${bin}:${process.env["PATH"] ?? ""}`;
    h.onModel(() => ({
      tool: "run_long",
      args: { label: "ambiguous", command: `touch ${quote(marker)}` },
    }));
    h.onModel(() => ({ text: "Waiting for launch to resolve" }));
    const received = Promise.withResolvers<string>();
    const respond = (turns: Turn[]) => {
      const text = lastUser(turns) ?? "";
      if (/job 1 \(ambiguous\) exited/.test(text)) {
        received.resolve(text);
        return { tool: "report", args: { status: "done", text: "Launch resolved" } };
      }
      h.onModel(respond);
      return { text: "Still waiting for the launch result" };
    };
    h.onModel(respond);
    worker();
    await settled(1);
    assert.ok(said("pane reply unavailable"));
    assert.equal(said("Your run is ending without a handoff"), false);
    assert.deepEqual(await jobResults(), []);
    const label = "job-1-ambiguous";
    const original = (await tabsInWorkspace()).find((tab) => tab["label"] === label)?.["tab_id"];
    assert.equal(typeof original, "string");
    await lab.run(["tab", "create", "--workspace", workspace(), "--label", label, "--no-focus"]);
    const decoy = (await tabsInWorkspace()).find(
      (tab) => tab["label"] === label && tab["tab_id"] !== original,
    )?.["tab_id"];
    assert.equal(typeof decoy, "string");
    const db = new DatabaseSync(fleet.cardd.db, { timeout: 5000 });
    t.after(() => db.close());
    db.exec(`CREATE TRIGGER refuse_expiry BEFORE UPDATE OF state ON jobs
    WHEN OLD.label = 'ambiguous' AND NEW.state = 'finished'
    BEGIN SELECT RAISE(ABORT, 'injected startup write failure'); END;
    UPDATE jobs SET created_at = created_at - 60000 WHERE label = 'ambiguous';`);
    await until(
      () => (fleet.cardd.errors.includes("injected startup write failure") ? true : undefined),
      "cardd to try and fail to persist the startup outcome",
    );
    assert.deepEqual(await jobResults(), []);
    assert.deepEqual(
      (await tabsInWorkspace()).filter((tab) => tab["label"] === label).map((tab) => tab["tab_id"]),
      [original, decoy],
    );
    db.exec("DROP TRIGGER refuse_expiry");
    const abort = AbortSignal.timeout(20_000);
    const deadline = new Promise<never>((_resolve, reject) => {
      abort.addEventListener("abort", () => reject(abort.reason), { once: true });
    });
    assert.match(
      await Promise.race([received.promise, deadline]),
      /exited 127: .*startup deadline/,
    );
    assert.equal(
      h.events.filter((event) => event["type"] === "fleet_connected").length,
      dropFence ? 2 : 1,
    );
    assert.deepEqual(await jobResults(), [
      [1, 127, "could not start: wrapper did not register before the startup deadline"],
    ]);
    assert.equal(readFileSync(dispatches, "utf8"), "dispatch\n");
    assert.equal(existsSync(marker), false);
    await waitTabGone(String(original), "tab_id");
    assert.deepEqual(readFileSync(closes, "utf8").trim().split("\n"), [original, original]);
    assert.ok((await tabsInWorkspace()).some((tab) => tab["tab_id"] === decoy));
  });

for (const fault of ["failed", "hanging"] as const) {
  test(`a partial job list preserves the wait and a ${fault} read cannot block the result`, async (t) => {
    let mode: "observe" | "omit" | typeof fault = "observe";
    const lists: number[][] = [];
    const activities: string[] = [];
    const disconnect = await jobProxy(
      t,
      callCardd,
      false,
      (reply) => {
        assert.ok(reply.ok);
        lists.push(check(OPS.jobs.result, reply.value).map(({ id }) => id));
        if (mode === "omit") return { ...reply, value: [] };
        if (mode === "failed")
          return { t: "result", id: reply.id, ok: false, error: "jobs read unavailable" };
        if (mode === "hanging") return undefined;
        return reply;
      },
      undefined,
      undefined,
      undefined,
      (message) => {
        if (message.t === "activity") activities.push(message.state);
      },
    );
    const slow = commandAwaitingGo(81);
    h.onModel(() => ({ tool: "run_long", args: { label: "partial", command: slow.command } }));
    h.onModel(() => ({ text: "Waiting for the command" }));
    const pi = worker();
    await until(() => (existsSync(slow.ready) ? true : undefined), "the registered command to run");
    await settled(1);
    disconnect();
    await until(
      () => (lists.some((ids) => ids.includes(1)) ? true : undefined),
      "a full list to show the registered job",
    );
    h.onModel(() => ({ text: "Full snapshot acknowledged" }));
    const fullDelivered = h.events.filter((event) => event["type"] === "fleet_delivered").length;
    await fleet.main.call("comment", {
      card: card.id,
      text: "Acknowledge the full snapshot",
      later: false,
    });
    await h.waitForNth(
      (event) => event["type"] === "fleet_delivered",
      fullDelivered + 1,
      "a push that the worker can only receive after applying the full snapshot",
    );
    await settled(2);
    const beforePartial = lists.length;
    mode = "omit";
    disconnect();
    await until(
      () => (lists.length > beforePartial ? true : undefined),
      "the partial reconnect list",
    );
    assert.deepEqual(lists.at(-1), [1]);
    h.onModel(() => ({ text: "Snapshot acknowledged" }));
    h.onModel(() => ({ text: "Still waiting for the running job" }));
    const deliveredBefore = h.events.filter((event) => event["type"] === "fleet_delivered").length;
    await fleet.main.call("comment", {
      card: card.id,
      text: "Acknowledge the snapshot",
      later: false,
    });
    await h.waitForNth(
      (event) => event["type"] === "fleet_delivered",
      deliveredBefore + 1,
      "a push that the worker can only receive after applying the partial snapshot",
    );
    await settled(3);
    const sentBefore = activities.length;
    pi.prompt("Check whether the job is still being waited on");
    await settled(4);
    assert.equal(said("Your run is ending without a handoff"), false);
    const sent = await until(() => {
      const after = activities.slice(sentBefore);
      return after.includes("running") && after.at(-1) !== "running" ? after.at(-1) : undefined;
    }, "the worker to send its settled activity after the partial list");
    assert.equal(sent, "waiting");
    const beforeFault = lists.length;
    mode = fault;
    disconnect();
    await until(
      () => (lists.length > beforeFault ? true : undefined),
      "the unanswered or rejected job read",
    );
    writeFileSync(slow.go, "");
    await until(
      () => (said("job 1 (partial) exited 0: late") ? true : undefined),
      "the durable result despite the list failure",
    );
    assert.deepEqual(await jobResults(), [[1, 0, "late"]]);
  });
}

for (const fault of ["failed", "partial"] as const) {
  test(`an automatic stop after cold reload respects a running job despite a ${fault} initial list`, async (t) => {
    const faultSent = Promise.withResolvers<number[]>();
    let reportCalls = 0;
    let reloading = false;
    await jobProxy(
      t,
      callCardd,
      false,
      (reply) => {
        if (!reloading) return reply;
        assert.ok(reply.ok);
        faultSent.resolve(check(OPS.jobs.result, reply.value).map(({ id }) => id));
        return fault === "failed"
          ? { t: "result", id: reply.id, ok: false, error: "jobs read unavailable" }
          : { ...reply, value: [] };
      },
      (reply) => {
        reportCalls += 1;
        return reply;
      },
    );
    const slow = commandAwaitingGo(82);
    t.after(() => {
      if (existsSync(jobDir)) writeFileSync(slow.go, "");
    });
    h.onModel(() => ({ tool: "run_long", args: { label: "cold", command: slow.command } }));
    h.onModel(() => ({ text: "Waiting for the command" }));
    const first = worker();
    await until(() => (existsSync(slow.ready) ? true : undefined), "the registered command to run");
    await settled(1);
    await first.kill();

    reloading = true;
    const second = worker();
    await h.waitForNth(
      (e) => e["type"] === "fleet_connected",
      2,
      "the new worker process to connect",
    );
    assert.deepEqual(await faultSent.promise, [1]);
    h.onModel(() => ({ text: "The command still has work" }));
    second.prompt("Check on the command after reload");
    await settled(2);
    const published = await untilAsync(async () => {
      const state = (await cardView()).card.activity?.state;
      return state === "running" ? undefined : state;
    }, "the worker to publish its settled activity");
    assert.equal(published, "waiting");
    assert.equal(reportCalls, 0);
    assert.equal(said("Your run is ending without a handoff"), false);
    assert.deepEqual(await cardReports(), []);
    assert.equal(await status(fleet.main, card), "working");

    h.onModel(() => ({ text: "The command has finished" }));
    h.onModel(() => ({ text: "Nothing else to report" }));
    writeFileSync(slow.go, "");
    await fleet.main.waitForEntry(
      (entry) => entry.kind === "report" && entry.fields["status"] === "stopped",
      "the stopped handoff after the command exits",
    );
    assert.deepEqual(await jobResults(), [[1, 0, "late"]]);
    assert.ok(said("Your run is ending without a handoff"));
    assert.deepEqual(await cardReports(), [
      ["stopped", "ended the run without a handoff: Nothing else to report"],
    ]);
    assert.equal(await status(fleet.main, card), "with-mate");
  });
}

for (const paneReply of ["intact", "unreadable"] as const)
  test(`a generic stop before a delayed fence preserves exact tab cleanup and rejects an ${paneReply} pane reply`, async (t) => {
    const registration = Promise.withResolvers<void>();
    let registering = false;
    const stopDelivery = Promise.withResolvers<void>();
    const fenceDelivery = Promise.withResolvers<void>();
    t.after(() => {
      registration.resolve();
      stopDelivery.resolve();
      fenceDelivery.resolve();
    });
    await jobProxy(
      t,
      async (op, args) => {
        if (op === "job.register") {
          registering = true;
          await registration.promise;
        }
        return callCardd(op, args);
      },
      fenceDelivery.promise,
      undefined,
      undefined,
      stopDelivery.promise,
    );
    const bin = join(jobDir, "bin");
    mkdirSync(bin);
    const accepted = join(jobDir, "pane-accepted");
    const release = join(jobDir, "release-reply");
    const marker = join(jobDir, "not-executed");
    const herdr = execFileSync("sh", ["-c", "command -v herdr"], { encoding: "utf8" }).trim();
    const waitForRelease = `const fs = require('node:fs'); const timer = setTimeout(() => process.exit(1), 30000);
const finish = () => { if (fs.existsSync(${JSON.stringify(release)})) { watcher.close(); clearTimeout(timer); } };
const watcher = fs.watch(${JSON.stringify(jobDir)}, finish); finish();`;
    writeFileSync(
      join(bin, "herdr"),
      `#!/bin/sh
if [ "$1 $2" = 'pane run' ]; then
  response=$(${quote(herdr)} "$@") || exit "$?"
  touch ${quote(accepted)}
  node -e ${quote(waitForRelease)} || exit "$?"
  ${paneTail(paneReply)}
fi
exec ${quote(herdr)} "$@"
`,
      { mode: 0o755 },
    );
    env["PATH"] = `${bin}:${process.env["PATH"] ?? ""}`;
    env["PROBE_STOP_RESULT"] = "1";
    h.onModel(() => ({
      tool: "run_long",
      args: { label: "delayed", command: `touch ${quote(marker)}` },
      alongside: [{ tool: "stop_job", args: { job: 1 } }],
    }));
    h.onModel(() => ({ tool: "report", args: { status: "failed", text: "Startup was fenced" } }));
    worker();
    await until(
      () => (existsSync(accepted) && registering ? true : undefined),
      "Herdr to accept the dispatch and the wrapper to request registration",
    );
    const tab = (await tabsInWorkspace()).find((each) => each["label"] === "job-1-delayed")?.[
      "tab_id"
    ];
    assert.equal(typeof tab, "string");
    await lab.run(["tab", "rename", String(tab), "actual-delayed"]);
    await lab.run([
      "tab",
      "create",
      "--workspace",
      workspace(),
      "--label",
      "job-1-delayed",
      "--no-focus",
    ]);
    const decoy = (await tabsInWorkspace()).find((each) => each["label"] === "job-1-delayed")?.[
      "tab_id"
    ];
    assert.equal(typeof decoy, "string");
    const db = new DatabaseSync(fleet.cardd.db, { timeout: 5000 });
    try {
      db.prepare("UPDATE jobs SET created_at = created_at - 60000 WHERE id = 1").run();
    } finally {
      db.close();
    }
    const fence = await untilAsync(
      async () =>
        (await cardView()).entries.find((entry) => entry.fields["startupFenced"] === true),
      "cardd to commit expiry without delivering the fence",
    );
    const delivered = (event: Record<string, unknown>): boolean =>
      event["type"] === "fleet_delivered" && event["entryId"] === fence.id;
    stopDelivery.resolve();
    const stopped = await h.waitFor(
      (event) => event["type"] === "stop_result",
      "the worker to process the generic stop reply",
    );
    assert.equal(stopped["isError"], false);
    assert.deepEqual(stopped["content"], [
      { type: "text", text: "job 1 (delayed) is not running: nothing to stop." },
    ]);
    assert.ok((await tabsInWorkspace()).some((each) => each["tab_id"] === tab));
    assert.equal(h.events.some(delivered), false);
    fenceDelivery.resolve();
    await h.waitFor(delivered, "the delayed fence before the pane reply");
    await waitTabGone(String(tab), "tab_id");
    assert.ok((await tabsInWorkspace()).some((each) => each["tab_id"] === decoy));
    assert.equal(existsSync(marker), false);
    writeFileSync(release, "");
    await h.waitForCall(1);
    assert.ok(said("Job 1 was fenced during dispatch"));
    assert.equal(said("Started job 1"), false);
    assert.equal(said("pane reply unavailable"), false);
    assert.deepEqual(await jobResults(), [
      [1, 127, "could not start: wrapper did not register before the startup deadline"],
    ]);
  });

for (const paneReply of ["intact", "unreadable"] as const)
  test(`a registered no-start result received before an ${paneReply} pane reply rejects the launch as not started`, async (t) => {
    const release = join(jobDir, "release-reply");
    const accepted = join(jobDir, "pane-accepted");
    const marker = join(jobDir, "not-executed");
    const registrationReply = Promise.withResolvers<void>();
    t.after(() => registrationReply.resolve());
    const lists: number[][] = [];
    let registrations = 0;
    const disconnect = await jobProxy(
      t,
      async (op, args) => {
        const result = await callCardd(op, args);
        if (op !== "job.register") return result;
        registrations += 1;
        if (registrations === 1) await registrationReply.promise;
        return { ...result, body: '{"ok":true,"value":{} }' };
      },
      false,
      (reply) => {
        assert.ok(reply.ok);
        lists.push(check(OPS.jobs.result, reply.value).map(({ id }) => id));
        return reply;
      },
    );
    const bin = join(jobDir, "bin");
    mkdirSync(bin);
    const herdr = execFileSync("sh", ["-c", "command -v herdr"], { encoding: "utf8" }).trim();
    const waitForRelease = `const fs = require('node:fs'); const timer = setTimeout(() => process.exit(1), 30000);
const finish = () => { if (fs.existsSync(${JSON.stringify(release)})) { watcher.close(); clearTimeout(timer); } };
const watcher = fs.watch(${JSON.stringify(jobDir)}, finish); finish();`;
    writeFileSync(
      join(bin, "herdr"),
      `#!/bin/sh
if [ "$1 $2" = 'pane run' ]; then
  response=$(${quote(herdr)} "$@") || exit "$?"
  touch ${quote(accepted)}
  node -e ${quote(waitForRelease)} || exit "$?"
  ${paneTail(paneReply)}
fi
exec ${quote(herdr)} "$@"
`,
      { mode: 0o755 },
    );
    env["PATH"] = `${bin}:${process.env["PATH"] ?? ""}`;
    t.after(() => writeFileSync(release, ""));
    h.onModel(() => ({
      tool: "run_long",
      args: { label: "unconfirmed", command: `touch ${quote(marker)}` },
    }));
    h.onModel(() => ({
      tool: "report",
      args: { status: "failed", text: "The job did not start" },
    }));
    worker();
    await until(() => (existsSync(accepted) ? true : undefined), "Herdr to accept the dispatch");
    await until(() => (registrations === 1 ? true : undefined), "the registration request");
    const beforeSnapshot = lists.length;
    disconnect();
    await until(
      () => (lists.slice(beforeSnapshot).some((ids) => ids.includes(1)) ? true : undefined),
      "the reconnect snapshot to show the registered job",
    );
    registrationReply.resolve();
    const result = await untilAsync(
      async () =>
        (await cardView()).entries.find(
          (entry) => entry.kind === "job-result" && entry.fields["commandNotStarted"] === true,
        ),
      "the wrapper's durable no-start result",
    );
    await h.waitFor(
      (event) => event["type"] === "fleet_delivered" && event["entryId"] === result.id,
      "the exact no-start result to reach the worker before the pane reply",
    );
    writeFileSync(release, "");
    await h.waitForCall(1);
    assert.ok(said("did not start: its wrapper reported that the command never ran"));
    assert.equal(said("Started job 1"), false);
    assert.equal(said("pane reply unavailable"), false);
    assert.equal(existsSync(marker), false);
    assert.deepEqual(await jobResults(), [
      [1, 127, "could not start: cardd did not confirm wrapper registration"],
    ]);
  });

test("a reconnect snapshot of a registered wrapper is not proof that the command ran, so a delayed pane reply reports an unconfirmed dispatch", async (t) => {
  const release = join(jobDir, "release-reply");
  const accepted = join(jobDir, "pane-accepted");
  const marker = join(jobDir, "not-executed");
  const registrationReply = Promise.withResolvers<void>();
  t.after(() => registrationReply.resolve());
  const lists: number[][] = [];
  let registrations = 0;
  const disconnect = await jobProxy(
    t,
    async (op, args) => {
      const result = await callCardd(op, args);
      if (op !== "job.register") return result;
      registrations += 1;
      if (registrations === 1) await registrationReply.promise;
      return { ...result, body: '{"ok":true,"value":{} }' };
    },
    false,
    (reply) => {
      assert.ok(reply.ok);
      lists.push(check(OPS.jobs.result, reply.value).map(({ id }) => id));
      return reply;
    },
  );
  const bin = join(jobDir, "bin");
  mkdirSync(bin);
  const herdr = execFileSync("sh", ["-c", "command -v herdr"], { encoding: "utf8" }).trim();
  const waitForRelease = `const fs = require('node:fs'); const timer = setTimeout(() => process.exit(1), 30000);
const finish = () => { if (fs.existsSync(${JSON.stringify(release)})) { watcher.close(); clearTimeout(timer); } };
const watcher = fs.watch(${JSON.stringify(jobDir)}, finish); finish();`;
  writeFileSync(
    join(bin, "herdr"),
    `#!/bin/sh
if [ "$1 $2" = 'pane run' ]; then
  response=$(${quote(herdr)} "$@") || exit "$?"
  touch ${quote(accepted)}
  node -e ${quote(waitForRelease)} || exit "$?"
  printf '%s\\n' "$response"
  exit 0
fi
exec ${quote(herdr)} "$@"
`,
    { mode: 0o755 },
  );
  env["PATH"] = `${bin}:${process.env["PATH"] ?? ""}`;
  t.after(() => writeFileSync(release, ""));
  h.onModel(() => ({
    tool: "run_long",
    args: { label: "snapshotted", command: `touch ${quote(marker)}` },
  }));
  h.onModel(() => ({ tool: "report", args: { status: "failed", text: "The job did not start" } }));
  h.onModel(() => ({ text: "Noted" }));
  worker();
  await until(() => (existsSync(accepted) ? true : undefined), "Herdr to accept the dispatch");
  await until(() => (registrations === 1 ? true : undefined), "the registration request");
  const beforeSnapshot = lists.length;
  disconnect();
  await until(
    () => (lists.slice(beforeSnapshot).some((ids) => ids.includes(1)) ? true : undefined),
    "the reconnect snapshot to show the registered job",
  );
  const deliveredBefore = h.events.filter((event) => event["type"] === "fleet_delivered").length;
  await fleet.main.call("comment", {
    card: card.id,
    text: "Queued behind the snapshot",
    later: false,
  });
  await h.waitForNth(
    (event) => event["type"] === "fleet_delivered",
    deliveredBefore + 1,
    "a push that the worker can only receive after applying the snapshot",
  );
  writeFileSync(release, "");
  await h.waitForCall(1);
  assert.ok(
    said(
      "Dispatched job 1 (snapshotted) in tab job-1-snapshotted; its startup is not yet confirmed.",
    ),
  );
  assert.equal(said("Started job 1"), false);
  assert.equal(existsSync(marker), false);
  assert.deepEqual(await jobResults(), []);
  registrationReply.resolve();
  await untilAsync(
    async () => ((await jobResults()).length > 0 ? true : undefined),
    "the wrapper's durable no-start result",
  );
  assert.equal(existsSync(marker), false);
  assert.deepEqual(await jobResults(), [
    [1, 127, "could not start: cardd did not confirm wrapper registration"],
  ]);
});

for (const legacy of [false, true])
  for (const paneReply of ["intact", "unreadable"] as const)
    test(`a successful result received before an ${paneReply} pane reply still reports the ${legacy ? "legacy " : ""}launch as started`, async (t) => {
      const release = join(jobDir, "release-reply");
      const accepted = join(jobDir, "pane-accepted");
      await jobProxy(t, async (op, args) =>
        legacy && op === "job.prepare"
          ? { status: 400, body: { ok: false, error: "unknown operation job.prepare" } }
          : callCardd(op, args),
      );
      const bin = join(jobDir, "bin");
      mkdirSync(bin);
      const herdr = execFileSync("sh", ["-c", "command -v herdr"], { encoding: "utf8" }).trim();
      const waitForRelease = `const fs = require('node:fs'); const timer = setTimeout(() => process.exit(1), 30000);
const finish = () => { if (fs.existsSync(${JSON.stringify(release)})) { watcher.close(); clearTimeout(timer); } };
const watcher = fs.watch(${JSON.stringify(jobDir)}, finish); finish();`;
      writeFileSync(
        join(bin, "herdr"),
        `#!/bin/sh
if [ "$1 $2" = 'pane run' ]; then
  response=$(${quote(herdr)} "$@") || exit "$?"
  touch ${quote(accepted)}
  node -e ${quote(waitForRelease)} || exit "$?"
  ${paneTail(paneReply)}
fi
exec ${quote(herdr)} "$@"
`,
        { mode: 0o755 },
      );
      env["PATH"] = `${bin}:${process.env["PATH"] ?? ""}`;
      t.after(() => writeFileSync(release, ""));
      h.onModel(() => ({
        tool: "run_long",
        args: { label: "quick", command: "echo finished-before-ack" },
      }));
      h.onModel(() => ({ tool: "report", args: { status: "done", text: "The job succeeded" } }));
      worker();
      await until(() => (existsSync(accepted) ? true : undefined), "Herdr to accept the dispatch");
      const result = await untilAsync(
        async () =>
          (await cardView()).entries.find(
            (entry) => entry.kind === "job-result" && entry.fields["exitCode"] === 0,
          ),
        "the command's durable successful result",
      );
      await h.waitFor(
        (event) => event["type"] === "fleet_delivered" && event["entryId"] === result.id,
        "the exact successful result to reach the worker before the pane reply",
      );
      writeFileSync(release, "");
      await h.waitForCall(1);
      assert.ok(said("Started job 1 (quick) in tab job-1-quick."));
      await until(
        () => (said("job 1 (quick) exited 0: finished-before-ack") ? true : undefined),
        "the successful result in the model's context",
      );
      assert.deepEqual(await jobResults(), [[1, 0, "finished-before-ack"]]);
    });

test("a legacy dispatch whose pane reply fails while the command runs keeps its wait and records only the real result", async (t) => {
  const activities: string[] = [];
  await jobProxy(
    t,
    async (op, args) =>
      op === "job.prepare"
        ? { status: 400, body: { ok: false, error: "unknown operation job.prepare" } }
        : callCardd(op, args),
    false,
    undefined,
    undefined,
    undefined,
    undefined,
    (message) => {
      if (message.t === "activity") activities.push(message.state);
    },
  );
  const bin = join(jobDir, "bin");
  mkdirSync(bin);
  const dispatches = join(jobDir, "dispatches");
  const herdr = execFileSync("sh", ["-c", "command -v herdr"], { encoding: "utf8" }).trim();
  writeFileSync(
    join(bin, "herdr"),
    `#!/bin/sh
if [ "$1 $2" = 'pane run' ]; then
  response=$(${quote(herdr)} "$@") || exit "$?"
  echo dispatch >> ${quote(dispatches)}
  echo 'pane reply unavailable' >&2
  exit 1
fi
exec ${quote(herdr)} "$@"
`,
    { mode: 0o755 },
  );
  env["PATH"] = `${bin}:${process.env["PATH"] ?? ""}`;
  const slow = commandAwaitingGo(84);
  t.after(() => {
    if (existsSync(h.dir)) writeFileSync(slow.go, "");
  });
  h.onModel(() => ({ tool: "run_long", args: { label: "inflight", command: slow.command } }));
  h.onModel(() => ({ text: "Waiting for the command" }));
  h.onModel(() => ({ tool: "report", args: { status: "done", text: "The legacy job finished" } }));
  worker();
  await until(() => (existsSync(slow.ready) ? true : undefined), "the legacy command to run");
  await settled(1);
  await until(
    () => (activities.at(-1) === "waiting" ? true : undefined),
    "the worker to publish that it is waiting",
  );
  assert.ok(said("Could not confirm dispatch for job 1"));
  assert.equal(said("Started job 1"), false);
  assert.equal(said("Your run is ending without a handoff"), false);
  assert.equal(readFileSync(dispatches, "utf8"), "dispatch\n");
  assert.deepEqual(await jobResults(), []);
  assert.equal(await status(fleet.main, card), "working");
  writeFileSync(slow.go, "");
  await fleet.main.waitForEntry((entry) => entry.body === "The legacy job finished", "the handoff");
  assert.deepEqual(await jobResults(), [[1, 0, "late"]]);
  assert.equal(readFileSync(dispatches, "utf8"), "dispatch\n");
});

for (const fault of [
  "worker reload",
  "relative scratch root",
  "unlink failure",
  "unlink failure and replacement",
  "marker promotion failure",
] as const)
  test(`a legacy dispatch that Herdr never accepted keeps its wait and tab until cardd reports it lost, then removes its launch file across ${fault}`, async (t) => {
    const lossDelivery = Promise.withResolvers<void>();
    t.after(() => lossDelivery.resolve());
    const activities: string[] = [];
    const disconnect = await jobProxy(
      t,
      async (op, args) =>
        op === "job.prepare"
          ? { status: 400, body: { ok: false, error: "unknown operation job.prepare" } }
          : callCardd(op, args),
      lossDelivery.promise,
      undefined,
      undefined,
      undefined,
      undefined,
      (message) => {
        if (message.t === "activity") activities.push(message.state);
      },
    );
    const bin = join(jobDir, "bin");
    mkdirSync(bin);
    const dispatches = join(jobDir, "dispatches");
    const signals = join(jobDir, "signals");
    const marker = join(jobDir, "unexpected-execution");
    const herdr = execFileSync("sh", ["-c", "command -v herdr"], { encoding: "utf8" }).trim();
    writeFileSync(
      join(bin, "herdr"),
      `#!/bin/sh
if [ "$1 $2" = 'pane run' ]; then
  echo dispatch >> ${quote(dispatches)}
  echo 'pane reply unavailable' >&2
  exit 1
fi
if [ "$1 $2" = 'pane send-keys' ] || [ "$1 $2" = 'tab close' ]; then
  echo "$@" >> ${quote(signals)}
fi
exec ${quote(herdr)} "$@"
`,
      { mode: 0o755 },
    );
    env["PATH"] = `${bin}:${process.env["PATH"] ?? ""}`;
    const launchFiles = (): string[] =>
      readdirSync(jobDir).filter((name) => /^fleet-job-1-.*\.json$/.test(name));
    const lostMessage =
      "[fleet] c-1 users-see-one-scrollbar job 1 (refused) lost: no heartbeat arrived";
    h.onModel(() => ({
      tool: "run_long",
      args: { label: "refused", command: `touch ${quote(marker)}` },
    }));
    h.onModel(() => ({ text: "Waiting for the command" }));
    h.onModel(() => ({ tool: "report", args: { status: "failed", text: "The job is lost" } }));
    if (fault === "relative scratch root") env["TMPDIR"] = "../jobs";
    const first = worker();
    await settled(1);
    await until(
      () => (activities.at(-1) === "waiting" ? true : undefined),
      "the worker to publish that it is waiting",
    );
    assert.ok(said("Could not confirm dispatch for job 1"));
    const [name] = launchFiles();
    assert.ok(name !== undefined);
    assert.equal(launchFiles().length, 1);
    const tab = (await tabsInWorkspace()).find((each) => each["label"] === "job-1-refused");
    assert.equal(typeof tab?.["tab_id"], "string");
    const lost = await untilAsync(
      async () =>
        (await cardView()).entries.find(
          (entry) => entry.kind === "job-result" && entry.fields["lost"] === true,
        ),
      "cardd to record the job as lost",
    );
    assert.equal(
      h.events.some((event) => event["type"] === "fleet_delivered" && event["entryId"] === lost.id),
      false,
    );
    assert.equal(said(lostMessage), false);
    assert.equal(launchFiles().length, 1);
    const path = join(jobDir, name);
    const replacementTmp = join(h.dir, "replacement-tmp");
    const decoy = join(replacementTmp, name);
    const failing = fault !== "worker reload" && fault !== "relative scratch root";
    const promotionBlock = join(
      process.env["FLEET_HOST_DIR"] ?? "",
      "job-launch-files",
      createHash("sha256")
        .update(env["FLEET_TOKEN"] ?? "")
        .digest("hex")
        .slice(0, 32),
      "1.pending",
    );
    const delivered = (): number =>
      h.events.filter(
        (event) => event["type"] === "fleet_delivered" && event["entryId"] === lost.id,
      ).length;
    if (!failing) {
      mkdirSync(replacementTmp);
      writeFileSync(decoy, "not the launch file");
      await first.kill();
      env["TMPDIR"] = replacementTmp;
      worker();
      await h.waitFor(
        (event) => event["type"] === "fleet_delivered" && event["entryId"] === lost.id,
        "the replacement worker to receive the exact loss entry",
      );
      assert.equal(launchFiles().length, 0);
    } else {
      if (fault === "marker promotion failure") {
        mkdirSync(promotionBlock, { recursive: true });
        writeFileSync(join(promotionBlock, "keep"), "");
      } else {
        rmSync(path);
        mkdirSync(path);
        writeFileSync(join(path, "keep"), "");
      }
      lossDelivery.resolve();
    }
    await until(() => (said(lostMessage) ? true : undefined), "the loss to reach the worker");
    if (!failing) {
      assert.equal(readFileSync(decoy, "utf8"), "not the launch file");
    } else if (fault === "marker promotion failure") {
      await until(
        () => (said("could not be marked for removal") ? true : undefined),
        "the worker to report the failed marker promotion",
      );
      assert.equal(launchFiles().length, 1);
      rmSync(promotionBlock, { recursive: true });
      disconnect();
      await until(
        () => (launchFiles().length === 0 ? true : undefined),
        "the next pass to finish the cleanup",
      );
    } else {
      await until(
        () => (said(`launch file ${path} could not be removed`) ? true : undefined),
        "the worker to report the failed unlink",
      );
      assert.ok(existsSync(path));
    }
    if (fault === "unlink failure and replacement") {
      const db = new DatabaseSync(fleet.cardd.db, { readOnly: true, timeout: 5000 });
      t.after(() => db.close());
      await untilAsync(
        () =>
          db
            .prepare(
              "SELECT 1 AS found FROM deliveries WHERE session = ? AND entry = ? AND state IN ('acknowledged', 'confirmed')",
            )
            .get("c-1-a1", lost.id) === undefined
            ? undefined
            : true,
        "cardd to persist the acknowledgment of the exact loss entry",
      );
      assert.equal(delivered(), 1);
      rmSync(path, { recursive: true });
      writeFileSync(path, "launch file after writes recover");
      mkdirSync(replacementTmp);
      writeFileSync(decoy, "not the launch file");
      await first.kill();
      env["TMPDIR"] = replacementTmp;
      worker();
      await h.waitForNth(
        (event) => event["type"] === "fleet_connected",
        2,
        "the replacement worker to connect",
      );
      await until(
        () => (launchFiles().length === 0 ? true : undefined),
        "the replacement worker to finish the interrupted cleanup",
      );
      assert.equal(readFileSync(decoy, "utf8"), "not the launch file");
      assert.equal(delivered(), 1);
    }
    assert.deepEqual(
      (await cardView()).entries
        .filter((entry) => entry.kind === "job-result")
        .map((entry) => [entry.fields["lost"], entry.fields["exitCode"]]),
      [[true, undefined]],
    );
    assert.ok((await tabsInWorkspace()).some((each) => each["tab_id"] === tab?.["tab_id"]));
    assert.equal(existsSync(marker), false);
    assert.equal(readFileSync(dispatches, "utf8"), "dispatch\n");
    assert.equal(existsSync(signals), false);
  });

test("a legacy loss that arrives before dispatch stops the launch explicitly and leaves no launch file", async (t) => {
  await jobProxy(t, async (op, args) =>
    op === "job.prepare"
      ? { status: 400, body: { ok: false, error: "unknown operation job.prepare" } }
      : callCardd(op, args),
  );
  const bin = join(jobDir, "bin");
  mkdirSync(bin);
  const dispatches = join(jobDir, "dispatches");
  const signals = join(jobDir, "signals");
  const requested = join(jobDir, "tab-requested");
  const release = join(jobDir, "release-tab");
  const marker = join(jobDir, "unexpected-execution");
  const herdr = execFileSync("sh", ["-c", "command -v herdr"], { encoding: "utf8" }).trim();
  const waitForRelease = `const fs = require('node:fs'); const timer = setTimeout(() => process.exit(1), 30000);
const finish = () => { if (fs.existsSync(${JSON.stringify(release)})) { watcher.close(); clearTimeout(timer); } };
const watcher = fs.watch(${JSON.stringify(jobDir)}, finish); finish();`;
  writeFileSync(
    join(bin, "herdr"),
    `#!/bin/sh
if [ "$1 $2" = 'tab create' ]; then
  touch ${quote(requested)}
  node -e ${quote(waitForRelease)} || exit "$?"
fi
if [ "$1 $2" = 'pane run' ]; then
  echo dispatch >> ${quote(dispatches)}
fi
if [ "$1 $2" = 'pane send-keys' ] || [ "$1 $2" = 'tab close' ]; then
  echo "$@" >> ${quote(signals)}
fi
exec ${quote(herdr)} "$@"
`,
    { mode: 0o755 },
  );
  env["PATH"] = `${bin}:${process.env["PATH"] ?? ""}`;
  t.after(() => writeFileSync(release, ""));
  const launchFiles = (): string[] =>
    readdirSync(jobDir).filter((name) => /^fleet-job-1-.*\.json$/.test(name));
  h.onModel(() => ({
    tool: "run_long",
    args: { label: "slow-tab", command: `touch ${quote(marker)}` },
  }));
  h.onModel(() => ({ text: "The launch failed" }));
  worker();
  await until(() => (existsSync(requested) ? true : undefined), "the launch to reach tab creation");
  assert.equal(launchFiles().length, 1);
  const lost = await untilAsync(
    async () =>
      (await cardView()).entries.find(
        (entry) => entry.kind === "job-result" && entry.fields["lost"] === true,
      ),
    "cardd to report the job lost before dispatch",
  );
  await h.waitFor(
    (event) => event["type"] === "fleet_delivered" && event["entryId"] === lost.id,
    "the worker to apply the loss",
  );
  assert.equal(launchFiles().length, 0);
  writeFileSync(release, "");
  await settled(1);
  assert.ok(said("Job 1 was reported lost before dispatch; nothing was run"));
  assert.equal(said("Started job 1"), false);
  assert.equal(said("Dispatched job 1"), false);
  assert.equal(existsSync(dispatches), false);
  assert.equal(existsSync(signals), false);
  assert.equal(existsSync(marker), false);
  assert.deepEqual(
    (await cardView()).entries
      .filter((entry) => entry.kind === "job-result")
      .map((entry) => [entry.fields["lost"], entry.fields["exitCode"]]),
    [[true, undefined]],
  );
  const db = new DatabaseSync(fleet.cardd.db, { readOnly: true, timeout: 5000 });
  t.after(() => db.close());
  assert.deepEqual(
    { ...db.prepare("SELECT state, exit_code FROM jobs WHERE id = 1").get() },
    {
      state: "lost",
      exit_code: null,
    },
  );
  assert.ok((await tabsInWorkspace()).some((each) => each["label"] === "job-1-slow-tab"));
});

test("an explicit stop receipt that precedes the prepare receipt fences the launch before any tab exists", async (t) => {
  const prepareReply = Promise.withResolvers<void>();
  const fenceDelivery = Promise.withResolvers<void>();
  const stopGate = Promise.withResolvers<void>();
  t.after(() => {
    prepareReply.resolve();
    fenceDelivery.resolve();
    stopGate.resolve();
  });
  await jobProxy(
    t,
    async (op, args) => {
      const result = await callCardd(op, args);
      if (op === "job.prepare") {
        stopGate.resolve();
        await prepareReply.promise;
      }
      return result;
    },
    fenceDelivery.promise,
    undefined,
    undefined,
    stopGate.promise,
  );
  const bin = join(jobDir, "bin");
  mkdirSync(bin);
  const dispatches = join(jobDir, "dispatches");
  const tabs = join(jobDir, "tab-requests");
  const marker = join(jobDir, "unexpected-execution");
  const herdr = execFileSync("sh", ["-c", "command -v herdr"], { encoding: "utf8" }).trim();
  writeFileSync(
    join(bin, "herdr"),
    `#!/bin/sh
if [ "$1 $2" = 'pane run' ]; then
  echo dispatch >> ${quote(dispatches)}
fi
if [ "$1 $2" = 'tab create' ]; then
  echo tab >> ${quote(tabs)}
fi
exec ${quote(herdr)} "$@"
`,
    { mode: 0o755 },
  );
  env["PATH"] = `${bin}:${process.env["PATH"] ?? ""}`;
  env["PROBE_STOP_RESULT"] = "1";
  h.onModel(() => ({
    tool: "run_long",
    args: { label: "cancelled", command: `touch ${quote(marker)}` },
    alongside: [{ tool: "stop_job", args: { job: 1 } }],
  }));
  h.onModel(() => ({ text: "The launch was stopped" }));
  worker();
  const stopped = await h.waitFor(
    (event) => event["type"] === "stop_result",
    "the stop to be confirmed before the prepare receipt",
  );
  assert.deepEqual(stopped["content"], [
    {
      type: "text",
      text: "job 1 (cancelled) was stopped before wrapper registration. Its command will not run.",
    },
  ]);
  assert.equal(
    (await tabsInWorkspace()).some((each) => String(each["label"]).startsWith("job-1-")),
    false,
  );
  assert.equal(existsSync(tabs), false);
  prepareReply.resolve();
  await settled(1);
  assert.ok(said("Job 1 cannot start: it was stopped before dispatch"));
  assert.equal(said("Dispatched job 1"), false);
  assert.equal(said("Started job 1"), false);
  assert.equal(
    (await tabsInWorkspace()).some((each) => String(each["label"]).startsWith("job-1-")),
    false,
  );
  assert.equal(existsSync(tabs), false);
  assert.equal(existsSync(dispatches), false);
  assert.equal(existsSync(marker), false);
});

test("a legacy launcher failure never overwrites a committed loss that its worker has not yet received", async (t) => {
  const lossDelivery = Promise.withResolvers<void>();
  t.after(() => lossDelivery.resolve());
  await jobProxy(
    t,
    async (op, args) =>
      op === "job.prepare"
        ? { status: 400, body: { ok: false, error: "unknown operation job.prepare" } }
        : callCardd(op, args),
    lossDelivery.promise,
  );
  const bin = join(jobDir, "bin");
  mkdirSync(bin);
  const dispatches = join(jobDir, "dispatches");
  const requested = join(jobDir, "tab-requested");
  const release = join(jobDir, "release-tab");
  const marker = join(jobDir, "unexpected-execution");
  const herdr = execFileSync("sh", ["-c", "command -v herdr"], { encoding: "utf8" }).trim();
  const waitForRelease = `const fs = require('node:fs'); const timer = setTimeout(() => process.exit(1), 30000);
const finish = () => { if (fs.existsSync(${JSON.stringify(release)})) { watcher.close(); clearTimeout(timer); } };
const watcher = fs.watch(${JSON.stringify(jobDir)}, finish); finish();`;
  writeFileSync(
    join(bin, "herdr"),
    `#!/bin/sh
if [ "$1 $2" = 'tab create' ]; then
  touch ${quote(requested)}
  node -e ${quote(waitForRelease)} || exit "$?"
  echo 'tab create unavailable' >&2
  exit 1
fi
if [ "$1 $2" = 'pane run' ]; then
  echo dispatch >> ${quote(dispatches)}
fi
exec ${quote(herdr)} "$@"
`,
    { mode: 0o755 },
  );
  env["PATH"] = `${bin}:${process.env["PATH"] ?? ""}`;
  t.after(() => writeFileSync(release, ""));
  h.onModel(() => ({
    tool: "run_long",
    args: { label: "doomed", command: `touch ${quote(marker)}` },
  }));
  h.onModel(() => ({ text: "The launch failed" }));
  h.onModel(() => ({ tool: "report", args: { status: "failed", text: "The job is lost" } }));
  worker();
  await until(() => (existsSync(requested) ? true : undefined), "the launch to reach tab creation");
  const lost = await untilAsync(
    async () =>
      (await cardView()).entries.find(
        (entry) => entry.kind === "job-result" && entry.fields["lost"] === true,
      ),
    "cardd to commit the loss",
  );
  assert.equal(
    h.events.some((event) => event["type"] === "fleet_delivered" && event["entryId"] === lost.id),
    false,
  );
  writeFileSync(release, "");
  await settled(1);
  assert.ok(said("tab create unavailable"));
  assert.deepEqual(
    (await cardView()).entries
      .filter((entry) => entry.kind === "job-result")
      .map((entry) => [entry.fields["lost"], entry.fields["exitCode"]]),
    [[true, undefined]],
  );
  const db = new DatabaseSync(fleet.cardd.db, { readOnly: true, timeout: 5000 });
  t.after(() => db.close());
  assert.deepEqual(
    { ...db.prepare("SELECT state, exit_code FROM jobs WHERE id = 1").get() },
    {
      state: "lost",
      exit_code: null,
    },
  );
  lossDelivery.resolve();
  await until(
    () =>
      said("[fleet] c-1 users-see-one-scrollbar job 1 (doomed) lost: no heartbeat arrived")
        ? true
        : undefined,
    "the loss to reach the worker after the launcher failed",
  );
  assert.equal(existsSync(dispatches), false);
  assert.equal(existsSync(marker), false);
});

const staleNotice = (job: number, label: string, kind: "lost" | "revived"): number => {
  const db = new DatabaseSync(fleet.cardd.db, { timeout: 5000 });
  try {
    const fields = JSON.stringify({ job, label, [kind]: true });
    const body =
      kind === "lost"
        ? `job ${String(job)} (${label}) lost: no heartbeat arrived`
        : `job ${String(job)} (${label}) is running again`;
    const { lastInsertRowid } = db
      .prepare(
        "INSERT INTO entries (card, author, kind, body, fields, created_at) VALUES (?, 'check', 'job-result', ?, ?, ?)",
      )
      .run(card.id, body, fields, Date.now());
    db.prepare(
      "INSERT INTO deliveries (session, entry, state, updated_at) VALUES ('c-1-a1', ?, 'pending', ?)",
    ).run(lastInsertRowid, Date.now());
    return Number(lastInsertRowid);
  } finally {
    db.close();
  }
};

for (const stale of [
  "revival after an acknowledged completion",
  "loss after an acknowledged revival",
]) {
  test(`a replayed ${stale} cannot change the replacement worker's wait`, async (t) => {
    const activities: string[] = [];
    await jobProxy(t, callCardd, false, undefined, undefined, undefined, undefined, (message) => {
      if (message.t === "activity") activities.push(message.state);
    });
    const completed = stale.startsWith("revival");
    const slow = commandAwaitingGo(85);
    t.after(() => {
      if (existsSync(h.dir)) writeFileSync(slow.go, "");
    });
    h.onModel(() => ({
      tool: "run_long",
      args: { label: "stale", command: completed ? "echo done" : slow.command },
    }));
    h.onModel(() => ({ text: "Waiting for the job" }));
    if (completed) h.onModel(() => ({ text: "The result was handled" }));
    const first = worker();
    if (completed) {
      await h.waitForNth((e) => e["type"] === "fleet_delivered", 1, "the job result");
      await settled(2);
      const db = new DatabaseSync(fleet.cardd.db, { readOnly: true, timeout: 5000 });
      t.after(() => db.close());
      await untilAsync(
        () =>
          db
            .prepare(
              `SELECT 1 AS found FROM deliveries d JOIN entries e ON e.id = d.entry
               WHERE d.session = 'c-1-a1' AND e.kind = 'job-result'
                 AND d.state IN ('acknowledged', 'confirmed')`,
            )
            .get() === undefined
            ? undefined
            : true,
        "cardd to persist the acknowledgment of the completion",
      );
    } else {
      await until(() => (existsSync(slow.ready) ? true : undefined), "the command to run");
      await settled(1);
    }
    await first.kill();
    const notice = staleNotice(1, "stale", completed ? "revived" : "lost");
    const delivered = h.events.filter((event) => event["type"] === "fleet_delivered").length;
    const settledBefore = h.events.filter((event) => event["type"] === "settled").length;
    h.onModel(() => ({ text: "The stale notice was handled" }));
    h.onModel(() => ({ text: "The follow-up was handled" }));
    const second = worker();
    await h.waitFor(
      (event) => event["type"] === "fleet_delivered" && event["entryId"] === notice,
      "the replacement worker to receive the stale notice",
    );
    assert.ok(h.events.filter((event) => event["type"] === "fleet_delivered").length > delivered);
    await h.waitForNth(
      (event) => event["type"] === "settled",
      settledBefore + 1,
      "the replacement worker to settle on the stale notice",
    );
    const sentBefore = activities.length;
    second.prompt("Is the job still being waited on?");
    await h.waitForNth(
      (event) => event["type"] === "settled",
      settledBefore + 2,
      "the follow-up turn",
    );
    const settledActivity = await until(() => {
      const after = activities.slice(sentBefore);
      return after.includes("running") && after.at(-1) !== "running" ? after.at(-1) : undefined;
    }, "the worker to send its settled activity after the follow-up turn");
    assert.equal(settledActivity, completed ? "idle" : "waiting");
    assert.equal(existsSync(slow.ready), !completed);
  });
}

test("run_long reports a dispatch as awaiting startup confirmation while registration is held, then delivers the result", async (t) => {
  const registration = Promise.withResolvers<void>();
  let registering = false;
  t.after(() => {
    registration.resolve();
  });
  await jobProxy(t, async (op, args) => {
    if (op === "job.register") {
      registering = true;
      await registration.promise;
    }
    return callCardd(op, args);
  });
  h.onModel(() => ({ tool: "run_long", args: { label: "held", command: "echo held-ok" } }));
  h.onModel(() => ({ text: "Waiting for the command" }));
  h.onModel(() => ({ tool: "report", args: { status: "done", text: "The held job ran" } }));
  worker();
  await h.waitForCall(1);
  assert.ok(
    said(
      "Dispatched job 1 (held) in tab job-1-held; its startup is not yet confirmed. Its result, or a failure to start, arrives as a [fleet] message",
    ),
  );
  assert.equal(said("Started job 1"), false);
  await until(() => (registering ? true : undefined), "the wrapper to request registration");
  assert.deepEqual(await jobResults(), []);
  registration.resolve();
  await fleet.main.waitForEntry((entry) => entry.body === "The held job ran", "the worker handoff");
  assert.deepEqual(await jobResults(), [[1, 0, "held-ok"]]);
});

test("an unknown idle verdict skips the nudge and the automatic stop, and a later confirmed idle run gets both", async (t) => {
  let unknown = true;
  let reportCalls = 0;
  await jobProxy(
    t,
    callCardd,
    false,
    undefined,
    (reply) => {
      reportCalls += 1;
      return reply;
    },
    undefined,
    (reply) =>
      unknown ? { t: "result", id: reply.id, ok: false, error: "idle verdict unavailable" } : reply,
  );
  h.onModel(() => ({ text: "Nothing is running." }));
  const pi = worker();
  await settled(1);
  assert.equal(said("Your run is ending without a handoff"), false);
  assert.equal(reportCalls, 0);
  assert.deepEqual(await cardReports(), []);
  assert.equal(await status(fleet.main, card), "working");

  unknown = false;
  h.onModel(() => ({ text: "Still nothing is running." }));
  h.onModel(() => ({ text: "Confirmed idle, nothing to report." }));
  pi.prompt("Check again");
  await fleet.main.waitForEntry(
    (entry) => entry.kind === "report" && entry.fields["status"] === "stopped",
    "the stopped handoff after a confirmed idle nudge",
  );
  assert.ok(said("Your run is ending without a handoff"));
  assert.deepEqual(await cardReports(), [
    ["stopped", "ended the run without a handoff: Confirmed idle, nothing to report."],
  ]);
});

test("a failed job-file write cannot hand off as stopped until cardd fences the reservation", async (t) => {
  const db = new DatabaseSync(fleet.cardd.db, { timeout: 5000 });
  t.after(() => db.close());
  db.exec(`CREATE TRIGGER refuse_startup_result BEFORE UPDATE ON jobs
    WHEN OLD.label = 'pre-dispatch' AND NEW.state = 'finished'
    BEGIN SELECT RAISE(ABORT, 'startup result unavailable'); END;`);
  let reportCalls = 0;
  await jobProxy(t, callCardd, false, undefined, (reply) => {
    reportCalls += 1;
    return reply;
  });
  const marker = join(h.dir, "unexpected-execution");
  h.onModel(() => {
    rmSync(jobDir, { recursive: true });
    return { tool: "run_long", args: { label: "pre-dispatch", command: `touch ${quote(marker)}` } };
  });
  h.onModel(() => ({ text: "The job failed to start." }));
  worker();
  await settled(1);
  assert.equal(reportCalls, 0);
  assert.ok(said("ENOENT"));
  assert.equal(said("Your run is ending without a handoff"), false);
  db.prepare("UPDATE jobs SET created_at = created_at - 60000 WHERE id = 1").run();
  await until(
    () =>
      fleet.cardd.errors.includes("Could not expire job startups: startup result unavailable")
        ? true
        : undefined,
    "cardd to attempt expiry while writes fail",
  );
  const job = db.prepare("SELECT state, wrapper_pid FROM jobs WHERE id = 1");
  assert.deepEqual({ ...job.get() }, { state: "running", wrapper_pid: null });
  assert.deepEqual(await jobResults(), []);
  assert.deepEqual(await cardReports(), []);
  assert.equal(await status(fleet.main, card), "working");

  h.onModel(() => ({ text: "Cardd fenced the failed launch." }));
  h.onModel(() => ({ text: "Nothing else to report." }));
  db.exec("DROP TRIGGER refuse_startup_result");
  await fleet.main.waitForEntry(
    (entry) => entry.fields["status"] === "stopped",
    "the stopped handoff after the reservation is fenced",
  );
  assert.ok(said("Your run is ending without a handoff"));
  const view = await cardView();
  assert.deepEqual(
    view.entries
      .filter((entry) => entry.kind === "job-result")
      .map((entry) => [entry.fields["startupFenced"], entry.fields["exitCode"], entry.body]),
    [[true, 127, "could not start: wrapper did not register before the startup deadline"]],
  );
  assert.ok(said("could not start: wrapper did not register before the startup deadline"));
  assert.deepEqual(await cardReports(), [
    ["stopped", "ended the run without a handoff: Nothing else to report."],
  ]);
  assert.equal(existsSync(marker), false);
});

test("an automatic stop committed before its reply was lost is not replayed on reconnect", async (t) => {
  let lists = 0;
  const disconnect = await jobProxy(
    t,
    callCardd,
    false,
    (reply) => {
      lists += 1;
      return reply;
    },
    (reply) => {
      assert.ok(reply.ok);
      assert.equal(check(OPS.report.result, reply.value).status, "with-mate");
      return undefined;
    },
  );
  h.onModel(() => ({ text: "The investigation is incomplete." }));
  h.onModel(() => ({ text: "No further work this turn." }));
  worker();
  const body = "ended the run without a handoff: No further work this turn.";
  await fleet.main.waitForEntry(
    (entry) => entry.kind === "report" && entry.body === body,
    "the first automatic stop to reach the mate",
  );
  await untilAsync(
    async () => ((await cardView()).card.activity?.state === "idle" ? true : undefined),
    "the worker to settle after the missing reply times out",
  );
  const beforeReconnect = lists;
  disconnect();
  await until(
    () => (lists > beforeReconnect ? true : undefined),
    "the worker to refresh jobs after reconnecting",
  );
  assert.deepEqual(await cardReports(), [["stopped", body]]);
  assert.equal(await status(fleet.main, card), "with-mate");
});

test("a run_long job runs with the worker's scratch folder, temp folder, and compile cache, not the host's defaults", async () => {
  const scratch = join(h.dir, "card");
  const cache = join(h.dir, "cache");
  mkdirSync(join(scratch, "tmp"), { recursive: true });
  env = {
    ...env,
    FLEET_SCRATCH: scratch,
    TMPDIR: join(scratch, "tmp"),
    NODE_COMPILE_CACHE: cache,
  };
  h.onModel(() => ({
    tool: "run_long",
    args: { label: "tests", command: 'echo "$FLEET_SCRATCH $TMPDIR $NODE_COMPILE_CACHE"' },
  }));
  h.onModel(() => ({ text: "waiting for the tests" }));
  h.onModel(() => ({ tool: "report", args: { status: "done", text: "seen" } }));
  worker();
  await fleet.main.waitForEntries(1);
  assert.equal(
    lastUser(await h.waitForCall(2)),
    `[fleet] c-1 users-see-one-scrollbar job 1 (tests) exited 0: ${scratch} ${join(scratch, "tmp")} ${cache}`,
  );
});

test("a finished job releases its tab while a running job's tab stays", async () => {
  const slow = commandAwaitingGo(9);
  h.onModel(() => ({ tool: "run_long", args: { label: "quick", command: "echo fast" } }));
  h.onModel(() => ({ tool: "run_long", args: { label: "slow", command: slow.command } }));
  h.onModel(() => ({ text: "waiting" }));
  h.onModel(() => ({ tool: "report", args: { status: "done", text: "seen" } }));
  try {
    worker();
    await until(() => (existsSync(slow.ready) ? true : undefined), "the slow job to start");
    const labels = async (): Promise<unknown[]> =>
      records(
        (await lab.run(["tab", "list", "--workspace", env["HERDR_WORKSPACE_ID"] ?? ""]))["tabs"],
      ).map((tab) => tab["label"]);
    const deadline = Date.now() + 10_000;
    while ((await labels()).includes("job-1-quick") && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(await labels(), ["1", "job-2-slow"]);
  } finally {
    writeFileSync(slow.go, "");
  }
});

test("a job keeps running across a worker restart, and its result arrives once", async () => {
  const counter = join(h.dir, "runs");
  const go = join(h.dir, "go");
  const command = `echo run >> ${counter}; while [ ! -f ${go} ]; do sleep 0.1; done; echo finished`;
  h.onModel(() => ({ tool: "run_long", args: { label: "wait", command } }));
  h.onModel(() => ({ text: "waiting for the job" }));
  const first = worker();
  await settled(1);
  await first.kill();
  writeFileSync(go, "");

  worker();
  await h.waitForNth((e) => e["type"] === "fleet_delivered", 2, "the job result after the restart");
  const after = await h.waitForCall(2);
  assert.equal(
    lastUser(after),
    "[fleet] c-1 users-see-one-scrollbar job 1 (wait) exited 0: finished",
  );
  assert.equal(
    after.filter((turn) => turn.text.startsWith("[fleet] c-1 users-see-one-scrollbar job 1"))
      .length,
    1,
  );
  assert.equal(existsSync(counter) ? readFileSync(counter, "utf8") : "", "run\n");
});

for (const kind of ["legacy", "registered", "replaced connection"] as const) {
  test(`stop after reload ${kind === "legacy" ? "still finds a confirmed legacy job" : `refuses a registered job without its exact tab ID (${kind})`}`, async (t) => {
    const legacy = kind === "legacy";
    if (kind !== "registered") {
      await jobProxy(t, async (op, args) => {
        if (legacy && op === "job.prepare")
          return { status: 400, body: { ok: false, error: "unknown operation job.prepare" } };
        if (kind === "replaced connection") {
          if (op === "job.cutover")
            return {
              status: 400,
              close: true,
              body: { ok: false, error: "unknown operation job.cutover" },
            };
          if (op === "job.stop")
            return { status: 200, body: { ok: true, value: { label: "reload", running: true } } };
        }
        return callCardd(op, args);
      });
    }
    const { ready, go, command } = commandAwaitingGo(27);
    h.onModel(() => ({ tool: "run_long", args: { label: "reload", command } }));
    h.onModel(() => ({ text: "Waiting for the job" }));
    const pi = worker();
    await until(() => (existsSync(ready) ? true : undefined), "the job command to start");
    await settled(1);
    const tab = (await tabsInWorkspace()).find((each) => each["label"] === "job-1-reload")?.[
      "tab_id"
    ];
    assert.ok(typeof tab === "string");
    if (!legacy) {
      await lab.run(["tab", "rename", tab, "actual-job"]);
      await lab.run([
        "tab",
        "create",
        "--workspace",
        workspace(),
        "--label",
        "job-1-reload",
        "--no-focus",
      ]);
    }
    pi.prompt("/probe-reload");
    await h.waitForNth((event) => event["type"] === "fleet_connected", 2, "the worker to reload");
    h.onModel(() => ({ tool: "stop_job", args: { job: 1 } }));
    h.onModel(() => ({ text: "Stop attempted" }));
    h.onModel(() => ({ tool: "report", args: { status: "done", text: "Reload test finished" } }));
    pi.prompt("Stop the job after reloading");
    await h.waitForCall(3);
    if (legacy) {
      assert.ok(said("Sent a stop to job 1 (reload)"));
      await h.waitForNth(
        (event) => event["type"] === "fleet_delivered",
        2,
        "the legacy stop result",
      );
      assert.deepEqual(await jobResults(), [[1, 130, "interrupted"]]);
    } else {
      assert.ok(said("has no verified tab ID in this worker session, so nothing was signalled"));
      assert.equal(said("Sent a stop to job 1 (reload)"), false);
      assert.ok(
        (await tabsInWorkspace()).some(
          (each) => each["tab_id"] === tab && each["label"] === "actual-job",
        ),
      );
      assert.ok((await tabsInWorkspace()).some((each) => each["label"] === "job-1-reload"));
      assert.deepEqual(await jobResults(), []);
      writeFileSync(go, "");
      await h.waitForNth(
        (event) => event["type"] === "fleet_delivered",
        2,
        "the untouched job's result",
      );
      assert.deepEqual(await jobResults(), [[1, 0, "late"]]);
    }
  });
}

function pids(text: string): number[] {
  try {
    return execFileSync("pgrep", ["-f", text], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean)
      .map(Number);
  } catch {
    return [];
  }
}

async function until<T>(read: () => T | undefined, what: string): Promise<T> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const uniqueSleepSeconds = (n: number): string => `4${String(process.pid)}${String(n)}`;

test("a timeout kills the whole command, exits 124, and leaves nothing behind", async () => {
  const command = `sleep ${uniqueSleepSeconds(1)} & wait`;
  h.onModel(() => ({ tool: "run_long", args: { label: "slow", command, timeout_minutes: 0.02 } }));
  h.onModel(() => ({ text: "waiting" }));
  h.onModel(() => ({ tool: "report", args: { status: "failed", text: "it timed out" } }));
  worker();
  await fleet.main.waitForEntries(1);

  assert.match(
    lastUser(await h.waitForCall(2)) ?? "",
    /^\[fleet\] c-1 users-see-one-scrollbar job 1 \(slow\) exited 124:/,
  );
  await until(
    () => (pids(uniqueSleepSeconds(1)).length === 0 ? true : undefined),
    "the sleep to be gone",
  );
});

test("a carriage return ends a line, and an endless line is cut to its last 2000 characters", async () => {
  const command = `printf 'x\\ry\\r\\n'; head -c 5000 /dev/zero | tr '\\0' a`;
  h.onModel(() => ({ tool: "run_long", args: { label: "progress", command } }));
  h.onModel(() => ({ text: "waiting" }));
  h.onModel(() => ({ tool: "report", args: { status: "done", text: "seen" } }));
  worker();
  await fleet.main.waitForEntries(1);

  const expected = `[fleet] c-1 users-see-one-scrollbar job 1 (progress) exited 0: x\ny\n${"a".repeat(2000)}`;
  assert.equal(lastUser(await h.waitForCall(2)), expected);
});

test("a command that ignores SIGTERM is killed when the grace ends", async () => {
  const command = `(trap '' TERM; exec sleep ${uniqueSleepSeconds(5)}) & wait`;
  h.onModel(() => ({
    tool: "run_long",
    args: { label: "stubborn", command, timeout_minutes: 0.01 },
  }));
  h.onModel(() => ({ text: "waiting" }));
  try {
    worker();
    const woken = await h.waitForCall(2, "default", 30_000);
    assert.match(
      lastUser(woken) ?? "",
      /^\[fleet\] c-1 users-see-one-scrollbar job 1 \(stubborn\) exited 124:/,
    );
    assert.deepEqual(pids(uniqueSleepSeconds(5)), []);
  } finally {
    for (const pid of pids(uniqueSleepSeconds(5))) process.kill(pid, "SIGKILL");
  }
});

test("an interrupted job reports exit 130, with the unfinished line before it", async () => {
  const ready = join(h.dir, "ready");
  const command = `echo started; printf partial; touch ${ready}; sleep ${uniqueSleepSeconds(2)}`;
  h.onModel(() => ({ tool: "run_long", args: { label: "wait", command } }));
  h.onModel(() => ({ text: "waiting" }));
  h.onModel(() => ({ tool: "report", args: { status: "failed", text: "interrupted" } }));
  worker();
  await until(() => (existsSync(ready) ? true : undefined), "the job to start");
  const [wrapper] = pids(join(jobDir, "fleet-job-1-"));
  assert.ok(wrapper !== undefined);
  process.kill(wrapper, "SIGINT");
  await fleet.main.waitForEntries(1);

  assert.equal(
    lastUser(await h.waitForCall(2)),
    "[fleet] c-1 users-see-one-scrollbar job 1 (wait) exited 130: started\npartial\ninterrupted",
  );
  await until(
    () => (pids(uniqueSleepSeconds(2)).length === 0 ? true : undefined),
    "the sleep to be gone",
  );
});

test("closing the job tab still reaches the worker: the result, or a lost job", async () => {
  const ready = join(h.dir, "ready-tab");
  const command = `trap 'echo dying; exit 3' TERM; echo started; touch ${ready}; sleep ${uniqueSleepSeconds(6)} & wait`;
  h.onModel(() => ({ tool: "run_long", args: { label: "tab", command } }));
  h.onModel(() => ({ text: "waiting" }));
  h.onModel(() => ({ tool: "report", args: { status: "failed", text: "the tab was closed" } }));
  try {
    worker();
    await until(() => (existsSync(ready) ? true : undefined), "the job to start");
    const listed = await lab.run(["tab", "list", "--workspace", env["HERDR_WORKSPACE_ID"] ?? ""]);
    const tab = records(listed["tabs"]).find((each) => each["label"] === "job-1-tab");
    assert.equal(typeof tab?.["tab_id"], "string");
    await lab.run(["tab", "close", String(tab?.["tab_id"])]);

    const woken = lastUser(await h.waitForCall(2, "default", 20_000)) ?? "";
    assert.ok(
      [
        "[fleet] c-1 users-see-one-scrollbar job 1 (tab) exited 130: started\ndying\ninterrupted",
        "[fleet] c-1 users-see-one-scrollbar job 1 (tab) lost: no heartbeat arrived. It is not run again.",
      ].includes(woken),
      woken,
    );
  } finally {
    for (const pid of pids(uniqueSleepSeconds(6))) process.kill(pid, "SIGKILL");
  }
});

test("a cardd stall longer than the keep-alive timeouts does not lose a live job", async () => {
  const { command, ready, go } = commandAwaitingGo(99);
  h.onModel(() => ({ tool: "run_long", args: { label: "stalled", command } }));
  h.onModel(() => ({ text: "waiting" }));
  h.onModel(() => ({ tool: "report", args: { status: "done", text: "finished" } }));
  worker();
  await until(
    () => (existsSync(ready) ? true : undefined),
    "the command to start after registration",
  );
  fleet.cardd.signal("SIGSTOP");
  await new Promise((resolve) => setTimeout(resolve, 6000));
  fleet.cardd.signal("SIGCONT");
  writeFileSync(go, "");

  const woken = lastUser(await h.waitForCall(2, "default", 30_000)) ?? "";
  assert.equal(woken, "[fleet] c-1 users-see-one-scrollbar job 1 (stalled) exited 0: late");
  assert.equal(said("no heartbeat"), false);
  assert.equal(
    findings().some((body) => body.includes("job lost")),
    false,
  );
});

const findings = (): string[] =>
  fleet.main.entries.filter(({ entry }) => entry.kind === "finding").map(({ entry }) => entry.body);

const commandAwaitingGo = (n: number): { command: string; ready: string; go: string } => {
  const ready = join(h.dir, `ready-${String(n)}`);
  const go = join(h.dir, `go-${String(n)}`);
  const command = `touch ${ready}; while [ ! -f ${go} ]; do sleep 0.1; done; echo late`;
  return { command, ready, go };
};

const wrapperOf = async (job: number, ready: string): Promise<number> => {
  await until(() => (existsSync(ready) ? true : undefined), "the job to start");
  const [wrapper] = pids(join(jobDir, `fleet-job-${String(job)}-`));
  assert.ok(wrapper !== undefined);
  return wrapper;
};

test("a job whose wrapper died is lost once: the mate and the worker are told", async () => {
  const first = commandAwaitingGo(1);
  const second = commandAwaitingGo(2);
  h.onModel(() => ({ tool: "run_long", args: { label: "first", command: first.command } }));
  h.onModel(() => ({ text: "waiting for the first job" }));
  h.onModel(() => ({ tool: "report", args: { status: "failed", text: "the first job is lost" } }));
  h.onModel(() => ({ text: "done" }));
  h.onModel(() => ({ tool: "run_long", args: { label: "second", command: second.command } }));
  h.onModel(() => ({ text: "waiting for the second job" }));
  try {
    worker();
    process.kill(await wrapperOf(1, first.ready), "SIGKILL");
    await until(() => (findings().length > 0 ? true : undefined), "the finding");
    assert.deepEqual(
      findings().map((body) => body.slice(0, 22)),
      ["job lost: job 1 (first"],
    );
    assert.ok(
      (await h.waitForCall(3)).some(
        (turn) =>
          turn.role === "user" &&
          turn.text.startsWith(
            "[fleet] c-1 users-see-one-scrollbar job 1 (first) lost: no heartbeat arrived",
          ),
      ),
    );
    const reported = (): boolean => fleet.main.entries.some(({ entry }) => entry.kind === "report");
    await until(() => (reported() ? true : undefined), "the worker's report");
    assert.equal(await status(fleet.main, card), "with-mate");

    await fleet.main.call("comment", { card: card.id, text: "run another job" });
    process.kill(await wrapperOf(2, second.ready), "SIGKILL");
    await until(() => (findings().length > 1 ? true : undefined), "the second finding");
    assert.deepEqual(
      findings().map((body) => body.slice(0, 22)),
      ["job lost: job 1 (first", "job lost: job 2 (secon"],
    );
  } finally {
    writeFileSync(first.go, "");
    writeFileSync(second.go, "");
  }
});

test("a result that arrives after the job was marked lost is still delivered once", async () => {
  const slow = commandAwaitingGo(3);
  h.onModel(() => ({ tool: "run_long", args: { label: "late", command: slow.command } }));
  h.onModel(() => ({ text: "waiting for the job" }));
  h.onModel(() => ({ tool: "report", args: { status: "failed", text: "the job is lost" } }));
  h.onModel(() => ({ text: "done" }));
  h.onModel(() => ({ tool: "report", args: { status: "done", text: "the job ended after all" } }));
  worker();
  const wrapper = await wrapperOf(1, slow.ready);
  process.kill(wrapper, "SIGSTOP");
  try {
    await until(() => (findings().length > 0 ? true : undefined), "the finding");
    assert.ok(
      (await h.waitForCall(3)).some(
        (turn) =>
          turn.role === "user" &&
          turn.text.startsWith(
            "[fleet] c-1 users-see-one-scrollbar job 1 (late) lost: no heartbeat arrived",
          ),
      ),
    );
    await until(
      () => (fleet.main.entries.some(({ entry }) => entry.kind === "report") ? true : undefined),
      "the worker's report",
    );
    writeFileSync(slow.go, "");
  } finally {
    process.kill(wrapper, "SIGCONT");
  }

  const after = await until(
    () => h.calls.find((turns) => lastUser(turns)?.includes("exited 0") === true),
    "the result",
  );
  assert.equal(lastUser(after), "[fleet] c-1 users-see-one-scrollbar job 1 (late) exited 0: late");
  assert.equal(after.filter((turn) => turn.text.includes("exited 0")).length, 1);
});

test("replayed lost and revival notices never change the tracked wait: only the finished job's result ends it", async () => {
  const slow = commandAwaitingGo(4);
  const routing =
    "pi-tiers: no usable model for tier 'default' (anthropic/claude-opus-5-5 on anthropic: cooling)";
  const nudge = "Your run is ending without a handoff";
  const again = "(sent again: the turn that got it ended before it was taken in)";
  const settledCount = (): number => h.events.filter((event) => event["type"] === "settled").length;
  const atCall: number[] = [];
  const failing = { lost: true, revival: false };
  const intake = (turns: Turn[]): { text: string } | { fail: string } | undefined => {
    const text = lastUser(turns) ?? "";
    if (text.includes("lost:") && !text.includes(again) && failing.lost) {
      failing.lost = false;
      return { fail: routing };
    }
    if (text.includes("is running again") && !text.includes(again) && failing.revival) {
      failing.revival = false;
      return { fail: routing };
    }
    return undefined;
  };
  h.onModel(() => {
    atCall.push(settledCount());
    return { tool: "run_long", args: { label: "stalled", command: slow.command } };
  });
  h.onModel(() => {
    atCall.push(settledCount());
    return { text: "waiting for the job" };
  });
  for (let i = 0; i < 30; i++)
    h.onModel((turns) => {
      atCall.push(settledCount());
      return intake(turns) ?? { text: "still waiting" };
    });
  const callWith = (match: (text: string) => boolean, from = 0): Promise<number> =>
    until(() => {
      const found = h.calls.findIndex((turns, i) => i >= from && match(lastUser(turns) ?? ""));
      return found < 0 ? undefined : found;
    }, "a notice to reach the model");
  const handled = async (call: number): Promise<void> => {
    await until(() => ((atCall[call] ?? Infinity) < settledCount() ? true : undefined), "settle");
  };
  const nudges = (): number =>
    h.calls.filter((turns) => (lastUser(turns) ?? "").includes(nudge)).length;
  const stopped = (): boolean =>
    fleet.main.entries.some(({ entry }) => entry.fields["status"] === "stopped");

  worker();
  const wrapper = await wrapperOf(1, slow.ready);
  process.kill(wrapper, "SIGSTOP");
  const lostCall = await callWith((text) => text.includes("lost:"));
  await fleet.main.waitForEntry(
    (entry) => entry.fields["condition"] === "runtime-failure",
    "the failed lost notice",
  );
  process.kill(wrapper, "SIGCONT");
  const revival = await callWith((text) => text.includes("is running again"), lostCall);
  await handled(revival);
  const replayedLost = await callWith(
    (text) => text.includes("lost:") && text.includes(again),
    revival,
  );
  await handled(replayedLost);
  assert.equal(nudges(), 0);
  assert.equal(stopped(), false);

  failing.revival = true;
  process.kill(wrapper, "SIGSTOP");
  const secondLost = await callWith(
    (text) => text.includes("lost:") && !text.includes(again),
    replayedLost + 1,
  );
  await handled(secondLost);
  process.kill(wrapper, "SIGCONT");
  const failedRevival = await callWith((text) => text.includes("is running again"), secondLost);
  await handled(failedRevival);
  writeFileSync(slow.go, "");
  const result = await callWith((text) => text.includes("exited 0"), failedRevival);
  await handled(result);
  const resultNudge = await callWith((text) => text.includes(nudge), result);
  await handled(resultNudge);
  const baseline = nudges();
  const replayedRevival = await callWith(
    (text) => text.includes("is running again") && text.includes(again),
    result,
  );
  await handled(replayedRevival);
  await until(() => (nudges() > baseline ? true : undefined), "a fresh nudge after the replay");
});
