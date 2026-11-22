import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, test, type TestContext } from "node:test";
import { check, OPS, type Card } from "@fleet/protocol";
import { quote } from "@fleet/protocol/route";
import { type Fleet } from "../support/fleet.ts";
import { JobLab } from "../support/job-lab.ts";
import {
  jobHelpers,
  lastUser,
  makeJobProxy,
  paneTail,
  until,
  withinMs,
} from "../support/job-env.ts";
import type { Harness } from "../support/harness.ts";
import { type Turn } from "../support/harness.ts";
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
const {
  worker,
  said,
  settled,
  callCardd,
  workspace,
  tabsInWorkspace,
  cardView,
  jobResults,
  waitTabGone,
  shim,
} = jobHelpers(current);
const jobProxy = makeJobProxy(current);

for (const dropFence of [false, true])
  test(`cardd fences ambiguous startup after failed writes ${dropFence ? "and replays after reconnect" : "without reconnecting"}`, async (t) => {
    await jobProxy(t, callCardd, dropFence);
    const dispatches = join(jobDir, "dispatches");
    const closes = join(jobDir, "closes");
    const marker = join(jobDir, "unexpected-execution");
    shim(
      (herdr) => `#!/bin/sh
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
    );
    h.onModel(() => ({
      tool: "run_long",
      args: { label: "ambiguous", command: `touch ${quote(marker)}` },
    }));
    h.onModel(() => ({ text: "Waiting for launch to resolve" }));
    const received = Promise.withResolvers<string>();
    const respond = (turns: Turn[]) => {
      const text = lastUser(turns) ?? "";
      if (text.includes("job 1 (ambiguous) exited")) {
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
    t.after(() => {
      db.close();
    });
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
    assert.match(await withinMs(received.promise, 20_000), /exited 127: .*startup deadline/);
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

type PaneReply = "intact" | "unreadable";

interface Delayed {
  readonly stopDelivery: PromiseWithResolvers<undefined>;
  readonly fenceDelivery: PromiseWithResolvers<undefined>;
  readonly disconnect: () => void;
  readonly activities: string[];
  readonly negatives: { count: number };
  readonly release: string;
  readonly marker: string;
}

async function dispatchDelayed(
  t: TestContext,
  paneReply: PaneReply,
  reconnect: boolean,
): Promise<Delayed> {
  const registration = Promise.withResolvers<undefined>();
  let registering = false;
  const stopDelivery = Promise.withResolvers<undefined>();
  const fenceDelivery = Promise.withResolvers<undefined>();
  t.after(() => {
    registration.resolve(undefined);
    stopDelivery.resolve(undefined);
    fenceDelivery.resolve(undefined);
  });
  const negatives = { count: 0 };
  const activities: string[] = [];
  const disconnect = await jobProxy(
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
    undefined,
    (message) => {
      if (message.t === "activity") activities.push(message.state);
    },
    (reply) => {
      if (reply.ok && !check(OPS["job.running"].result, reply.value).running) negatives.count += 1;
      return reply;
    },
    undefined,
    reconnect,
  );
  const accepted = join(jobDir, "pane-accepted");
  const release = join(jobDir, "release-reply");
  const marker = join(jobDir, "not-executed");
  const waitForRelease = `const fs = require('node:fs'); const timer = setTimeout(() => process.exit(1), 30000);
const finish = () => { if (fs.existsSync(${JSON.stringify(release)})) { watcher.close(); clearTimeout(timer); } };
const watcher = fs.watch(${JSON.stringify(jobDir)}, finish); finish();`;
  shim(
    (herdr) => `#!/bin/sh
if [ "$1 $2" = 'pane run' ]; then
  response=$(${quote(herdr)} "$@") || exit "$?"
  touch ${quote(accepted)}
  node -e ${quote(waitForRelease)} || exit "$?"
  ${paneTail(paneReply)}
fi
exec ${quote(herdr)} "$@"
`,
  );
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
  return { stopDelivery, fenceDelivery, disconnect, activities, negatives, release, marker };
}

async function fenceBesideDecoy() {
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
  jl.expireJob();
  const fence = await untilAsync(
    async () => (await cardView()).entries.find((entry) => entry.fields["startupFenced"] === true),
    "cardd to commit expiry without delivering the fence",
  );
  return { tab, decoy, fenceId: fence.id };
}

async function checkGenericStop(
  tab: unknown,
  delivered: (event: Record<string, unknown>) => boolean,
) {
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
}

async function checkNegativeRetry(
  delayed: Delayed,
  paneReply: PaneReply,
  tab: unknown,
  delivered: (event: Record<string, unknown>) => boolean,
) {
  const { activities, negatives, release } = delayed;
  delayed.disconnect();
  await until(
    () => (negatives.count > 0 ? true : undefined),
    "the reconnect's negative exact read before the fence",
  );
  assert.equal(h.events.some(delivered), false);
  assert.ok((await tabsInWorkspace()).some((each) => each["tab_id"] === tab));
  if (paneReply !== "unreadable") return;
  const mark = activities.length;
  writeFileSync(release, "");
  const settledActivity = await until(
    () => activities.slice(mark).findLast((state) => state !== "running"),
    "the worker to settle after the failed pane reply, before the fence",
  );
  assert.equal(settledActivity, "idle");
  assert.equal(h.events.some(delivered), false);
}

for (const [paneReply, reconnect] of [
  ["intact", false],
  ["unreadable", false],
  ["intact", true],
  ["unreadable", true],
] as const)
  test(`a generic stop${reconnect ? " and a negative exact retry" : ""} before a delayed fence preserve exact tab cleanup and reject an ${paneReply} pane reply`, async (t) => {
    const delayed = await dispatchDelayed(t, paneReply, reconnect);
    const { tab, decoy, fenceId } = await fenceBesideDecoy();
    const delivered = (event: Record<string, unknown>): boolean =>
      event["type"] === "fleet_delivered" && event["entryId"] === fenceId;
    delayed.stopDelivery.resolve(undefined);
    await checkGenericStop(tab, delivered);
    if (reconnect) await checkNegativeRetry(delayed, paneReply, tab, delivered);
    delayed.fenceDelivery.resolve(undefined);
    await h.waitFor(delivered, "the delayed fence before the pane reply");
    await waitTabGone(String(tab), "tab_id");
    assert.ok((await tabsInWorkspace()).some((each) => each["tab_id"] === decoy));
    assert.equal(existsSync(delayed.marker), false);
    const early = reconnect && paneReply === "unreadable";
    if (!early) writeFileSync(delayed.release, "");
    await h.waitForCall(1);
    assert.ok(
      said(early ? "Could not confirm dispatch for job 1" : "Job 1 was fenced during dispatch"),
    );
    assert.equal(said("Started job 1"), false);
    if (!early) assert.equal(said("pane reply unavailable"), false);
    assert.deepEqual(await jobResults(), [
      [1, 127, "could not start: wrapper did not register before the startup deadline"],
    ]);
  });

for (const paneReply of ["intact", "unreadable"] as const)
  test(`a registered no-start result received before an ${paneReply} pane reply rejects the launch as not started`, async (t) => {
    const release = join(jobDir, "release-reply");
    const accepted = join(jobDir, "pane-accepted");
    const marker = join(jobDir, "not-executed");
    const registrationReply = Promise.withResolvers<undefined>();
    t.after(() => {
      registrationReply.resolve(undefined);
    });
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
    const waitForRelease = `const fs = require('node:fs'); const timer = setTimeout(() => process.exit(1), 30000);
const finish = () => { if (fs.existsSync(${JSON.stringify(release)})) { watcher.close(); clearTimeout(timer); } };
const watcher = fs.watch(${JSON.stringify(jobDir)}, finish); finish();`;
    shim(
      (herdr) => `#!/bin/sh
if [ "$1 $2" = 'pane run' ]; then
  response=$(${quote(herdr)} "$@") || exit "$?"
  touch ${quote(accepted)}
  node -e ${quote(waitForRelease)} || exit "$?"
  ${paneTail(paneReply)}
fi
exec ${quote(herdr)} "$@"
`,
    );
    t.after(() => {
      writeFileSync(release, "");
    });
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
    registrationReply.resolve(undefined);
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
