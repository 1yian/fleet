import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { CardViewSchema, check, HttpOutcomeSchema, OPS } from "@fleet/protocol";
import { quote } from "@fleet/protocol/route";
import { begin, MINUTE, newCard, startFleet, type Fleet } from "../support/fleet.ts";
import { spawnGuarded } from "../support/guarded.ts";
import { HerdrLab } from "../support/herdr.ts";
import { serveCalls } from "../support/job-env.ts";
import { until } from "../support/live-fleet.ts";
import { tempDir } from "../support/run-root.ts";

const WRAPPER = fileURLToPath(new URL("../../packages/extension/src/job.ts", import.meta.url));

type Worker = Awaited<ReturnType<Fleet["cardd"]["connect"]>>;

interface Registration {
  readonly job: number;
  readonly launch: string;
  readonly pid: number;
}

interface Rig {
  readonly main: Fleet["main"];
  readonly cardd: Fleet["cardd"];
  readonly card: Awaited<ReturnType<typeof newCard>>;
  readonly token: string;
  readonly lab: HerdrLab;
  readonly dir: string;
  readonly permit: PromiseWithResolvers<undefined>;
  readonly seen: Registration[];
  readonly mode: { value: "retry" | "always-torn" };
  readonly url: string;
}

async function startRig(t: TestContext): Promise<Rig> {
  const { main, cardd } = await startFleet({ CARDD_TIMING_SCALE: "0.025" });
  t.after(() => cardd.stop());
  const card = await newCard(main, "Prove the startup receipt");
  const token = await begin(main, card);
  const lab = await HerdrLab.start({});
  t.after(() => lab.stop());
  const permit = Promise.withResolvers<undefined>();
  const seen: Registration[] = [];
  const mode: Rig["mode"] = { value: "retry" };
  const proxy = serveCalls(async (op, args) => {
    const result = await cardd.post(token, op, args);
    if (op !== "job.register") return result;
    seen.push(check(OPS["job.register"].args, args));
    if (mode.value === "always-torn" || seen.length === 1)
      return { status: result.status, body: '{"ok":true,"value":{} }' };
    await permit.promise;
    return result;
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  t.after(() => {
    permit.resolve(undefined);
    proxy.closeAllConnections();
    proxy.close();
  });
  const address = proxy.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${String(address.port)}/call`;
  return { main, cardd, card, token, lab, dir: tempDir("registration-"), permit, seen, mode, url };
}

async function startWrapper(rig: Rig, label: string) {
  const { cardd, token, lab, dir, url } = rig;
  const launch = randomUUID();
  const marker = join(dir, label);
  const command = `printf 'ran\\n' >> ${quote(marker)}; echo ${label}`;
  const response = await cardd.post(token, "job.prepare", { label, command, launch });
  const outcome = check(HttpOutcomeSchema, response.body);
  assert.ok(outcome.ok);
  const prepared = check(OPS["job.prepare"].result, outcome.value);
  assert.ok("heartbeatMs" in prepared);
  const { job, heartbeatMs } = prepared;
  const file = join(dir, `fleet-job-${String(job)}-${launch}.json`);
  const input = { url, token, job, heartbeatMs, timeoutMs: 20000, launch: { id: launch, command } };
  writeFileSync(file, JSON.stringify(input), { mode: 0o600 });
  const child = spawnGuarded(process.execPath, [WRAPPER, file], {
    env: { ...process.env, ...lab.owned, HERDR_TAB_ID: undefined },
    stdio: ["ignore", "inherit", "inherit"],
  });
  return { job, marker, exited: once(child, "exit") };
}

const silentJob = async (worker: Worker, label: string): Promise<number> =>
  check(OPS["job.start"].result, await worker.call("job.start", { label, command: "true" })).job;

const movedAt = async (rig: Rig): Promise<number> => {
  const board = check(OPS.board.result, await rig.main.call("board", {}));
  const pulse = board.find((each) => each.id === rig.card.id)?.pulse;
  assert.ok(pulse);
  return pulse.movedAt;
};

async function waitLost(rig: Rig, jobs: number[]): Promise<void> {
  for (const job of jobs)
    await rig.main.waitForEntry(
      (entry) =>
        entry.card === rig.card.id &&
        entry.fields["condition"] === "job-lost" &&
        entry.fields["job"] === job,
      `job ${String(job)} to be lost before the retries`,
    );
}

async function holdReceipt(rig: Rig, worker: Worker): Promise<number> {
  const { main, cardd, card, token, seen } = rig;
  await worker.call("report", { status: "working", text: "Checking wrapper startup receipts." });
  const first = await startWrapper(rig, "received");
  await until(() => (seen.length === 2 ? true : undefined), "the second registration request");
  assert.equal(seen[0]?.job, first.job);
  assert.deepEqual(seen[0], seen[1]);
  assert.equal(existsSync(first.marker), false);
  const identity = seen[0];
  assert.ok(identity);
  const conflicting = await cardd.post(token, "job.register", {
    ...identity,
    pid: identity.pid + 1,
  });
  assert.deepEqual(conflicting.body, { ok: true, value: { registered: false } });
  const lateLaunchError = await cardd.post(token, "job.finish", {
    job: first.job,
    beforeRegistration: identity.launch,
    exitCode: 127,
    outputTail: "ambiguous pane result",
  });
  assert.deepEqual(lateLaunchError.body, { ok: true, value: { recorded: false } });
  const receiptControl = await silentJob(worker, "receipt-window-control");
  await main.waitForEntry(
    (entry) => entry.fields["condition"] === "job-lost" && entry.fields["job"] === receiptControl,
    "the detector to report a job admitted after registration while the receipt is held",
  );
  assert.deepEqual(await worker.call("jobs", {}), [{ id: first.job, label: "received" }]);
  assert.equal(existsSync(first.marker), false);
  rig.permit.resolve(undefined);
  assert.deepEqual(await first.exited, [0, null]);
  assert.equal(readFileSync(first.marker, "utf8"), "ran\n");
  assert.equal(seen.filter(({ job }) => job === first.job).length, 2);
  const afterReceipt = check(CardViewSchema, await main.call("card", { card: card.id }));
  assert.deepEqual(
    afterReceipt.entries
      .filter((entry) => entry.fields["job"] === first.job)
      .map((entry) => [entry.kind, entry.fields["exitCode"], entry.body]),
    [["job-result", 0, "received"]],
  );
  return first.job;
}

async function refuseUnconfirmed(rig: Rig, worker: Worker): Promise<number> {
  const before = await movedAt(rig);
  rig.mode.value = "always-torn";
  const second = await startWrapper(rig, "unconfirmed");
  assert.deepEqual(await second.exited, [127, null]);
  assert.equal(existsSync(second.marker), false);
  assert.equal(rig.seen.filter(({ job }) => job === second.job).length, 3);
  const result = await worker.waitForEntry(
    (entry) => entry.kind === "job-result" && entry.fields["job"] === second.job,
    "the wrapper's no-start result",
  );
  assert.equal(result.fields["exitCode"], 127);
  assert.equal(result.fields["commandNotStarted"], true);
  assert.equal(result.fields["startupFenced"], undefined);
  assert.match(result.body, /did not confirm wrapper registration/);
  assert.equal(await movedAt(rig), before);
  return before;
}

function ageLosses(rig: Rig, minutes: number, jobs: number[]): void {
  const db = new DatabaseSync(rig.cardd.db, { timeout: 5000 });
  try {
    db.prepare("UPDATE jobs SET updated_at = ? WHERE state = 'lost' AND id IN (?, ?)").run(
      Date.now() - minutes * MINUTE,
      ...jobs,
    );
  } finally {
    db.close();
  }
}

const reminded = (rig: Rig, job: number, tier: number) =>
  rig.main.waitForEntry(
    (entry) =>
      entry.card === rig.card.id &&
      entry.fields["condition"] === "job-lost-open" &&
      Number(entry.fields["tier"]) >= tier &&
      entry.body.includes(`job ${String(job)} (`),
    `job ${String(job)} to receive reminder tier ${String(tier)}`,
  );

async function runSameLabel(rig: Rig, worker: Worker, before: number): Promise<void> {
  rig.mode.value = "retry";
  const third = await startWrapper(rig, "unconfirmed");
  assert.deepEqual(await third.exited, [0, null]);
  const completed = await worker.waitForEntry(
    (entry) => entry.kind === "job-result" && entry.fields["job"] === third.job,
    "the same-label command that actually ran",
  );
  assert.equal(completed.fields["exitCode"], 0);
  assert.ok(completed.createdAt > before);
  assert.equal(await movedAt(rig), completed.createdAt);
}

test("a prepared wrapper does not run Bash until a complete registration receipt arrives", async (t) => {
  const rig = await startRig(t);
  const worker = await rig.cardd.connect(rig.token);
  const lost = await silentJob(worker, "unconfirmed");
  const control = await silentJob(worker, "control");
  await waitLost(rig, [lost, control]);
  await holdReceipt(rig, worker);
  const before = await refuseUnconfirmed(rig, worker);
  ageLosses(rig, 1, [lost, control]);
  await reminded(rig, lost, 5);
  await runSameLabel(rig, worker, before);
  ageLosses(rig, 2, [lost, control]);
  await reminded(rig, control, 10);
  const view = check(CardViewSchema, await rig.main.call("card", { card: rig.card.id }));
  assert.equal(
    view.entries.some(
      (entry) =>
        entry.fields["condition"] === "job-lost-open" &&
        Number(entry.fields["tier"]) >= 10 &&
        entry.body.includes(`job ${String(lost)} (`),
    ),
    false,
  );
});
