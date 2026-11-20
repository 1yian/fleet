import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  parseServerMessage,
  type Card,
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
  assert.ok(said("Started job 1 (tests) in tab job-1-tests."));
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

async function jobProxy(
  t: TestContext,
  call: (op: string, args: unknown) => Promise<{ status: number; body: unknown }>,
  dropFence = false,
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
        res.writeHead(result.status, { "content-type": "application/json" });
        res.end(typeof result.body === "string" ? result.body : JSON.stringify(result.body));
      })().catch((error: unknown) => res.destroy(error instanceof Error ? error : undefined));
    });
  });
  const sockets = new WebSocketServer({ server: proxy });
  sockets.on("connection", (client) => {
    const upstream = new WebSocket(fleet.cardd.url);
    client.pause();
    upstream.on("open", () => {
      client.resume();
    });
    client.on("message", (raw) => {
      if (upstream.readyState === WebSocket.OPEN) upstream.send(rawText(raw));
    });
    upstream.on("message", (raw) => {
      const text = rawText(raw);
      const message = parseServerMessage(text);
      if (dropFence && message.t === "entry" && message.entry.fields["startupFenced"] === true) {
        dropFence = false;
        client.terminate();
      } else if (client.readyState === WebSocket.OPEN) client.send(text);
    });
    upstream.on("error", () => client.terminate());
    upstream.on("close", () => client.terminate());
    client.on("error", () => upstream.terminate());
    client.on("close", () => upstream.terminate());
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    for (const client of sockets.clients) client.terminate();
    sockets.close();
    proxy.closeAllConnections();
    proxy.close();
  });
  const address = proxy.address();
  assert.ok(address && typeof address !== "string");
  env["FLEET_URL"] = `ws://127.0.0.1:${String(address.port)}/session`;
}

const callCardd = (op: string, args: unknown) =>
  fleet.cardd.post(env["FLEET_TOKEN"] ?? "", op, args);

const workspace = (): string => env["HERDR_WORKSPACE_ID"] ?? "";
const tabsInWorkspace = async () =>
  records((await lab.run(["tab", "list", "--workspace", workspace()]))["tabs"]);

const jobResults = async () =>
  check(CardViewSchema, await fleet.main.call("card", { card: card.id }))
    .entries.filter((entry) => entry.kind === "job-result")
    .map((entry) => [entry.fields["job"], entry.fields["exitCode"], entry.body]);

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
  assert.ok(said("Started job 1 (recover) in tab job-1-recover."));
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

for (const registrationFirst of [false, true]) {
  test(`stop_job ${registrationFirst ? "signals the pinned wrapper" : "fences the reservation"} while registration is in flight`, async (t) => {
    const waiting = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    t.after(() => release.resolve());
    const registered = Promise.withResolvers<boolean>();
    await jobProxy(t, async (op, args) => {
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
    const marker = join(jobDir, "unexpected-execution");
    h.onModel(() => ({
      tool: "run_long",
      args: { label: "stopping", command: `touch ${quote(marker)}` },
    }));
    h.onModel(async () => {
      await waiting.promise;
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
    assert.ok((await tabsInWorkspace()).some((tab) => tab["tab_id"] === decoy));
  });

test("a job-file failure does not keep Pi waiting when cardd cannot record the startup error", async () => {
  const db = new DatabaseSync(fleet.cardd.db, { timeout: 5000 });
  try {
    db.exec(`CREATE TRIGGER refuse_startup_result BEFORE UPDATE ON jobs
      WHEN OLD.label = 'pre-dispatch' AND NEW.state = 'finished'
      BEGIN SELECT RAISE(ABORT, 'startup result unavailable'); END;`);
  } finally {
    db.close();
  }
  const marker = join(h.dir, "unexpected-execution");
  h.onModel(() => {
    rmSync(jobDir, { recursive: true });
    return { tool: "run_long", args: { label: "pre-dispatch", command: `touch ${quote(marker)}` } };
  });
  h.onModel(() => ({ text: "The job failed to start." }));
  h.onModel(() => ({ text: "There is no job to wait for." }));
  worker();
  await settled(1);
  assert.ok(said("ENOENT"));
  assert.ok(said("Your run is ending without a handoff"));
  const stopped = await fleet.main.waitForEntry(
    (entry) => entry.fields["status"] === "stopped",
    "the worker's stopped handoff after the failed launch",
  );
  assert.match(stopped.body, /There is no job to wait for/);
  assert.equal(existsSync(marker), false);
  const view = check(CardViewSchema, await fleet.main.call("card", { card: card.id }));
  assert.deepEqual(
    view.entries.filter((entry) => entry.kind === "job-result"),
    [],
  );
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
