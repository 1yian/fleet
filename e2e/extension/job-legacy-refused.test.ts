import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, test, type TestContext } from "node:test";
import { type Card } from "@fleet/protocol";
import { quote } from "@fleet/protocol/route";
import { type Fleet } from "../support/fleet.ts";
import { JobLab } from "../support/job-lab.ts";
import { jobHelpers, makeJobProxy, until } from "../support/job-env.ts";
import type { Harness, Pi } from "../support/harness.ts";
import type { HerdrLab } from "../support/herdr.ts";
import { until as untilAsync } from "../support/live-fleet.ts";

let fleet: Fleet;
let h: Harness;
let lab: HerdrLab;
let env: Record<string, string>;
let jobDir: string;
let card: Card;
let jl: JobLab;
const current = () => ({ fleet, h, lab, env, jobDir, card });
beforeEach(async () => {
  jl = await JobLab.start();
  ({ fleet, h, lab, env, jobDir, card } = jl);
});
afterEach(async (t) => {
  await jl.stop(t);
});
const { worker, said, settled, callCardd, tabsInWorkspace, cardView, shim } = jobHelpers(current);
const jobProxy = makeJobProxy(current);

const FAULTS = [
  "worker reload",
  "relative scratch root",
  "unlink failure",
  "unlink failure and replacement",
  "marker promotion failure",
] as const;
type Fault = (typeof FAULTS)[number];

const lostMessage =
  "[fleet] c-1 users-see-one-scrollbar job 1 (refused) lost: no heartbeat arrived";

const launchFiles = (): string[] =>
  readdirSync(jobDir).filter((name) => /^fleet-job-1-.*\.json$/.test(name));

const lossDeliveries = (id: number): number =>
  h.events.filter((event) => event["type"] === "fleet_delivered" && event["entryId"] === id).length;

interface Refusal {
  readonly first: Pi;
  readonly disconnect: () => void;
  readonly lossDelivery: PromiseWithResolvers<undefined>;
  readonly dispatches: string;
  readonly signals: string;
  readonly marker: string;
}

interface Unreported {
  readonly name: string;
  readonly tab: unknown;
  readonly lostId: number;
}

async function refuseDispatch(t: TestContext, fault: Fault): Promise<Refusal> {
  const lossDelivery = Promise.withResolvers<undefined>();
  t.after(() => {
    lossDelivery.resolve(undefined);
  });
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
  const dispatches = join(jobDir, "dispatches");
  const signals = join(jobDir, "signals");
  const marker = join(jobDir, "unexpected-execution");
  shim(
    (herdr) => `#!/bin/sh
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
  );
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
  return { first, disconnect, lossDelivery, dispatches, signals, marker };
}

async function observeUnreported(): Promise<Unreported> {
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
  assert.equal(lossDeliveries(lost.id), 0);
  assert.equal(said(lostMessage), false);
  assert.equal(launchFiles().length, 1);
  return { name, tab: tab?.["tab_id"], lostId: lost.id };
}

const cleanupPaths = (name: string) => {
  const replacementTmp = join(h.dir, "replacement-tmp");
  return { path: join(jobDir, name), replacementTmp, decoy: join(replacementTmp, name) };
};

const promotionBlock = (): string =>
  join(
    process.env["FLEET_HOST_DIR"] ?? "",
    "job-launch-files",
    createHash("sha256")
      .update(env["FLEET_TOKEN"] ?? "")
      .digest("hex")
      .slice(0, 32),
    "1.pending",
  );

async function replaceWorker(first: Pi, paths: ReturnType<typeof cleanupPaths>): Promise<void> {
  mkdirSync(paths.replacementTmp);
  writeFileSync(paths.decoy, "not the launch file");
  await first.kill();
  env["TMPDIR"] = paths.replacementTmp;
  worker();
}

async function reloadAndAwaitLoss(
  first: Pi,
  unreported: Unreported,
  paths: ReturnType<typeof cleanupPaths>,
): Promise<void> {
  await replaceWorker(first, paths);
  await h.waitFor(
    (event) => event["type"] === "fleet_delivered" && event["entryId"] === unreported.lostId,
    "the replacement worker to receive the exact loss entry",
  );
  assert.equal(launchFiles().length, 0);
}

function breakCleanup(fault: Fault, path: string): void {
  if (fault === "marker promotion failure") {
    mkdirSync(promotionBlock(), { recursive: true });
    writeFileSync(join(promotionBlock(), "keep"), "");
  } else {
    rmSync(path);
    mkdirSync(path);
    writeFileSync(join(path, "keep"), "");
  }
}

async function awaitFailedCleanup(fault: Fault, path: string, disconnect: () => void) {
  if (fault === "marker promotion failure") {
    await until(
      () => (said("could not be marked for removal") ? true : undefined),
      "the worker to report the failed marker promotion",
    );
    assert.equal(launchFiles().length, 1);
    rmSync(promotionBlock(), { recursive: true });
    disconnect();
    await until(
      () => (launchFiles().length === 0 ? true : undefined),
      "the next pass to finish the cleanup",
    );
    return;
  }
  await until(
    () => (said(`launch file ${path} could not be removed`) ? true : undefined),
    "the worker to report the failed unlink",
  );
  assert.ok(existsSync(path));
}

async function replaceAfterAcknowledgedLoss(
  t: TestContext,
  first: Pi,
  lostId: number,
  paths: ReturnType<typeof cleanupPaths>,
): Promise<void> {
  const db = new DatabaseSync(fleet.cardd.db, { readOnly: true, timeout: 5000 });
  t.after(() => {
    db.close();
  });
  await untilAsync(
    () =>
      db
        .prepare(
          "SELECT 1 AS found FROM deliveries WHERE session = ? AND entry = ? AND state IN ('acknowledged', 'confirmed')",
        )
        .get("c-1-a1", lostId) === undefined
        ? undefined
        : true,
    "cardd to persist the acknowledgment of the exact loss entry",
  );
  assert.equal(lossDeliveries(lostId), 1);
  rmSync(paths.path, { recursive: true });
  writeFileSync(paths.path, "launch file after writes recover");
  await replaceWorker(first, paths);
  await h.waitForNth(
    (event) => event["type"] === "fleet_connected",
    2,
    "the replacement worker to connect",
  );
  await until(
    () => (launchFiles().length === 0 ? true : undefined),
    "the replacement worker to finish the interrupted cleanup",
  );
  assert.equal(readFileSync(paths.decoy, "utf8"), "not the launch file");
  assert.equal(lossDeliveries(lostId), 1);
}

async function endRefusal(
  t: TestContext,
  fault: Fault,
  refusal: Refusal,
  unreported: Unreported,
): Promise<void> {
  const { first, disconnect, lossDelivery } = refusal;
  const paths = cleanupPaths(unreported.name);
  const failing = fault !== "worker reload" && fault !== "relative scratch root";
  if (!failing) await reloadAndAwaitLoss(first, unreported, paths);
  else {
    breakCleanup(fault, paths.path);
    lossDelivery.resolve(undefined);
  }
  await until(() => (said(lostMessage) ? true : undefined), "the loss to reach the worker");
  if (!failing) assert.equal(readFileSync(paths.decoy, "utf8"), "not the launch file");
  else await awaitFailedCleanup(fault, paths.path, disconnect);
  if (fault === "unlink failure and replacement")
    await replaceAfterAcknowledgedLoss(t, first, unreported.lostId, paths);
}

for (const fault of FAULTS)
  test(`a legacy dispatch that Herdr never accepted keeps its wait and tab until cardd reports it lost, then removes its launch file across ${fault}`, async (t) => {
    const refusal = await refuseDispatch(t, fault);
    const unreported = await observeUnreported();
    await endRefusal(t, fault, refusal, unreported);
    assert.deepEqual(
      (await cardView()).entries
        .filter((entry) => entry.kind === "job-result")
        .map((entry) => [entry.fields["lost"], entry.fields["exitCode"]]),
      [[true, undefined]],
    );
    assert.ok((await tabsInWorkspace()).some((each) => each["tab_id"] === unreported.tab));
    assert.equal(existsSync(refusal.marker), false);
    assert.equal(readFileSync(refusal.dispatches, "utf8"), "dispatch\n");
    assert.equal(existsSync(refusal.signals), false);
  });

test("a legacy loss that arrives before dispatch stops the launch explicitly and leaves no launch file", async (t) => {
  await jobProxy(t, async (op, args) =>
    op === "job.prepare"
      ? { status: 400, body: { ok: false, error: "unknown operation job.prepare" } }
      : callCardd(op, args),
  );
  const dispatches = join(jobDir, "dispatches");
  const signals = join(jobDir, "signals");
  const requested = join(jobDir, "tab-requested");
  const release = join(jobDir, "release-tab");
  const marker = join(jobDir, "unexpected-execution");
  const waitForRelease = `const fs = require('node:fs'); const timer = setTimeout(() => process.exit(1), 30000);
const finish = () => { if (fs.existsSync(${JSON.stringify(release)})) { watcher.close(); clearTimeout(timer); } };
const watcher = fs.watch(${JSON.stringify(jobDir)}, finish); finish();`;
  shim(
    (herdr) => `#!/bin/sh
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
  );
  t.after(() => {
    writeFileSync(release, "");
  });
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
  t.after(() => {
    db.close();
  });
  assert.deepEqual(
    { ...db.prepare("SELECT state, exit_code FROM jobs WHERE id = 1").get() },
    {
      state: "lost",
      exit_code: null,
    },
  );
  assert.ok((await tabsInWorkspace()).some((each) => each["label"] === "job-1-slow-tab"));
});
