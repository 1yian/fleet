import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, test, type TestContext } from "node:test";
import { check, OPS, type Card, type Entry } from "@fleet/protocol";
import { type Fleet } from "../support/fleet.ts";
import { JobLab } from "../support/job-lab.ts";
import {
  jobHelpers,
  makeJobProxy,
  readJobList,
  until,
  type CallResult,
} from "../support/job-env.ts";
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
const { worker, settled, callCardd, cardView, commandAwaitingGo, wrapperOf } = jobHelpers(current);
const jobProxy = makeJobProxy(current);

const notices = ["loss", "revival"] as const;
const exactReadModes = ["complete", "failed", "hanging"] as const;

type Notice = (typeof notices)[number];
type ExactRead = (typeof exactReadModes)[number];

interface ReplayState {
  faulty: boolean;
  listReads: number;
  exactReads: number;
  exactVerdict: boolean | undefined;
  runningSnapshot: ReturnType<typeof readJobList> | undefined;
  readonly activities: string[];
}

interface Replay {
  readonly older: Notice;
  readonly seedNegative: boolean;
  readonly state: ReplayState;
  readonly release: PromiseWithResolvers<undefined>;
  readonly slow: ReturnType<typeof commandAwaitingGo>;
  readonly view: () => Promise<Entry[]>;
  readonly acknowledged: (entry: number) => boolean;
}

const deliveredEntry =
  (id: number) =>
  (event: Record<string, unknown>): boolean =>
    event["type"] === "fleet_delivered" && event["entryId"] === id;

function acknowledgements(t: TestContext): (entry: number) => boolean {
  const db = new DatabaseSync(fleet.cardd.db, { readOnly: true, timeout: 5000 });
  t.after(() => {
    db.close();
  });
  return (entry) =>
    db
      .prepare(
        "SELECT 1 AS found FROM deliveries WHERE session = 'c-1-a1' AND entry = ? AND state IN ('acknowledged', 'confirmed')",
      )
      .get(entry) !== undefined;
}

async function startReplayProxy(
  t: TestContext,
  older: Notice,
  exactRead: ExactRead,
  state: ReplayState,
  release: PromiseWithResolvers<undefined>,
): Promise<void> {
  const seedNegative = older === "revival" && exactRead === "complete";
  const fault = (reply: CallResult): CallResult | undefined => {
    if (exactRead === "complete") return reply;
    if (exactRead === "hanging") return undefined;
    return { t: "result", id: reply.id, ok: false, error: "job read unavailable" };
  };
  await jobProxy(
    t,
    callCardd,
    release.promise,
    (reply) => {
      if (!state.faulty) return reply;
      state.listReads += 1;
      if (state.listReads > 1) return fault(reply);
      if (state.runningSnapshot !== undefined) return { ...reply, value: state.runningSnapshot };
      return older === "loss" && exactRead === "complete" ? { ...reply, value: [] } : reply;
    },
    undefined,
    undefined,
    undefined,
    (message) => {
      if (message.t === "activity") state.activities.push(message.state);
    },
    (reply) => {
      if (state.faulty) {
        state.exactReads += 1;
        if (reply.ok) state.exactVerdict = check(OPS["job.running"].result, reply.value).running;
      }
      return state.faulty ? fault(reply) : reply;
    },
    (fields) => (older === "loss" ? fields["lost"] === true : fields["revived"] === true),
    seedNegative,
  );
}

async function settleEarlier(rep: Replay, lostId: number): Promise<void> {
  if (rep.older === "loss") {
    assert.equal(h.events.some(deliveredEntry(lostId)), false);
    return;
  }
  await h.waitFor(deliveredEntry(lostId), "the loss to reach the first worker");
  await untilAsync(
    () => (rep.acknowledged(lostId) ? true : undefined),
    "cardd to persist the acknowledgment of the earlier loss",
  );
}

async function settleLater(rep: Replay, revivedId: number): Promise<void> {
  const { older, seedNegative, state, slow, view, acknowledged } = rep;
  if (older === "loss") {
    await h.waitFor(deliveredEntry(revivedId), "the revival to reach the first worker");
    await untilAsync(
      () => (acknowledged(revivedId) ? true : undefined),
      "cardd to persist the acknowledgment of the revival",
    );
    return;
  }
  if (seedNegative) {
    const listed = await callCardd("jobs", {});
    assert.equal(listed.status, 200);
    state.runningSnapshot = readJobList(listed.body);
    assert.deepEqual(state.runningSnapshot, [{ id: 1, label: "replayed" }]);
  }
  writeFileSync(slow.go, "");
  const done = await untilAsync(
    async () => (await view()).find((entry) => entry.fields["exitCode"] === 0),
    "the durable completion",
  );
  await h.waitFor(deliveredEntry(done.id), "the completion to reach the first worker");
  await untilAsync(
    () => (acknowledged(done.id) ? true : undefined),
    "cardd to persist the acknowledgment of the completion",
  );
}

async function reachOutcomes(rep: Replay): Promise<{ first: Pi; heldId: number }> {
  const { slow, view } = rep;
  const first = worker();
  const wrapper = await wrapperOf(1, slow.ready);
  await settled(1);
  process.kill(wrapper, "SIGSTOP");
  const lost = await untilAsync(
    async () => (await view()).find((entry) => entry.fields["lost"] === true),
    "the detector to record the loss",
  );
  await settleEarlier(rep, lost.id);
  process.kill(wrapper, "SIGCONT");
  const revived = await untilAsync(
    async () => (await view()).find((entry) => entry.fields["revived"] === true),
    "the heartbeat to record the revival",
  );
  await settleLater(rep, revived.id);
  return { first, heldId: rep.older === "loss" ? lost.id : revived.id };
}

async function replayToReplacement(rep: Replay, first: Pi, heldId: number): Promise<void> {
  const { older, seedNegative, state, release, slow } = rep;
  const { activities } = state;
  assert.equal(rep.acknowledged(heldId), false);
  await first.kill();
  state.faulty = true;
  const replacementActivity = activities.length;
  const connectedBefore = h.events.filter((event) => event["type"] === "fleet_connected").length;
  const second = worker();
  await h.waitForNth(
    (event) => event["type"] === "fleet_connected",
    connectedBefore + 1,
    "the replacement to connect",
  );
  if (seedNegative) {
    await until(
      () => (activities.slice(replacementActivity).at(-1) === "waiting" ? true : undefined),
      "the replacement to publish the wait before receiving the replay",
    );
    assert.equal(state.exactReads, 0);
  }
  const settledBefore = h.events.filter((event) => event["type"] === "settled").length;
  release.resolve(undefined);
  await h.waitFor(deliveredEntry(heldId), "the replacement worker to receive the older notice");
  await h.waitForNth(
    (event) => event["type"] === "settled",
    settledBefore + 1,
    "the replacement worker to settle on the older notice",
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
  assert.equal(settledActivity, older === "loss" ? "waiting" : "idle");
  if (seedNegative) assert.equal(state.exactVerdict, false);
  assert.equal(existsSync(slow.ready), true);
  await until(
    () => (state.exactReads > 0 ? true : undefined),
    "the replacement worker to request the exact job read",
  );
}

for (const older of notices)
  for (const exactRead of exactReadModes)
    test(`a replayed older ${older} cannot change the replacement worker's wait (${exactRead} exact read)`, async (t) => {
      const release = Promise.withResolvers<undefined>();
      t.after(() => {
        release.resolve(undefined);
      });
      const state: ReplayState = {
        faulty: false,
        listReads: 0,
        exactReads: 0,
        exactVerdict: undefined,
        runningSnapshot: undefined,
        activities: [],
      };
      await startReplayProxy(t, older, exactRead, state, release);
      const slow = commandAwaitingGo(86);
      t.after(() => {
        if (existsSync(h.dir)) writeFileSync(slow.go, "");
      });
      h.onModel(() => ({ tool: "run_long", args: { label: "replayed", command: slow.command } }));
      h.onModel(() => ({ text: "Waiting for the job" }));
      for (let i = 0; i < 12; i++) h.onModel(() => ({ text: "Noted" }));
      const rep: Replay = {
        older,
        seedNegative: older === "revival" && exactRead === "complete",
        state,
        release,
        slow,
        view: async () => (await cardView()).entries.filter((entry) => entry.kind === "job-result"),
        acknowledged: acknowledgements(t),
      };
      const { first, heldId } = await reachOutcomes(rep);
      await replayToReplacement(rep, first, heldId);
    });

test("a failed exact read keeps a known wait through a genuine loss, and the reconnect read clears it", async (t) => {
  const activities: string[] = [];
  let failExact = false;
  let exactReads = 0;
  const disconnect = await jobProxy(
    t,
    callCardd,
    false,
    undefined,
    undefined,
    undefined,
    undefined,
    (message) => {
      if (message.t === "activity") activities.push(message.state);
    },
    (reply) => {
      exactReads += 1;
      return failExact
        ? { t: "result", id: reply.id, ok: false, error: "job read unavailable" }
        : reply;
    },
  );
  const slow = commandAwaitingGo(87);
  t.after(() => {
    if (existsSync(h.dir)) writeFileSync(slow.go, "");
  });
  h.onModel(() => ({ tool: "run_long", args: { label: "genuine", command: slow.command } }));
  h.onModel(() => ({ text: "Waiting for the job" }));
  for (let i = 0; i < 12; i++) h.onModel(() => ({ text: "Noted" }));
  const pi = worker();
  const wrapper = await wrapperOf(1, slow.ready);
  await settled(1);
  await until(() => (activities.at(-1) === "waiting" ? true : undefined), "the initial wait");
  failExact = true;
  process.kill(wrapper, "SIGSTOP");
  const lost = await untilAsync(
    async () =>
      (await cardView()).entries.find(
        (entry) => entry.kind === "job-result" && entry.fields["lost"] === true,
      ),
    "the detector to record the loss",
  );
  await h.waitFor(
    (event) => event["type"] === "fleet_delivered" && event["entryId"] === lost.id,
    "the loss to reach the worker",
  );
  await until(() => (exactReads > 0 ? true : undefined), "the failed exact read");
  const turn = async (text: string): Promise<string | undefined> => {
    const from = activities.length;
    const base = h.events.filter((event) => event["type"] === "settled").length;
    pi.prompt(text);
    await settled(base + 1);
    return until(() => {
      const after = activities.slice(from);
      return after.includes("running") && after.at(-1) !== "running" ? after.at(-1) : undefined;
    }, "the worker to send its settled activity");
  };
  assert.equal(await turn("Is the job still being waited on?"), "waiting");
  failExact = false;
  const readsBefore = exactReads;
  const activitiesBefore = activities.length;
  disconnect();
  await until(() => (exactReads > readsBefore ? true : undefined), "the reconnect exact read");
  await until(() => (activities.at(-1) === "idle" ? true : undefined), "idle without a new turn");
  assert.deepEqual(activities.slice(activitiesBefore), ["waiting", "idle"]);
});
