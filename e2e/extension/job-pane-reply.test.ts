import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { check, OPS, type Card } from "@fleet/protocol";
import { quote } from "@fleet/protocol/route";
import { status, type Fleet } from "../support/fleet.ts";
import { JobLab } from "../support/job-lab.ts";
import { jobHelpers, makeJobProxy, paneTail, until } from "../support/job-env.ts";
import type { Harness } from "../support/harness.ts";
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
const { worker, said, settled, callCardd, cardView, jobResults, commandAwaitingGo, shim } =
  jobHelpers(current);
const jobProxy = makeJobProxy(current);

test("a reconnect snapshot of a registered wrapper is not proof that the command ran, so a delayed pane reply reports an unconfirmed dispatch", async (t) => {
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
  printf '%s\\n' "$response"
  exit 0
fi
exec ${quote(herdr)} "$@"
`,
  );
  t.after(() => {
    writeFileSync(release, "");
  });
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
  registrationReply.resolve(undefined);
  await untilAsync(
    async () => ((await jobResults()).length > 0 ? true : undefined),
    "the wrapper's durable no-start result",
  );
  assert.equal(existsSync(marker), false);
  assert.deepEqual(await jobResults(), [
    [1, 127, "could not start: cardd did not confirm wrapper registration"],
  ]);
});

for (const [legacy, paneReply, code] of [
  [false, "intact", 0],
  [false, "unreadable", 0],
  [true, "intact", 0],
  [true, "unreadable", 0],
  [true, "intact", 3],
  [true, "unreadable", 3],
] as const)
  test(`a ${code === 0 ? "successful" : `failing (exit ${String(code)})`} result received before an ${paneReply} pane reply still reports the ${legacy ? "legacy " : ""}launch as started`, async (t) => {
    const release = join(jobDir, "release-reply");
    const accepted = join(jobDir, "pane-accepted");
    await jobProxy(t, async (op, args) =>
      legacy && op === "job.prepare"
        ? { status: 400, body: { ok: false, error: "unknown operation job.prepare" } }
        : callCardd(op, args),
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
      args: { label: "quick", command: `echo finished-before-ack; exit ${String(code)}` },
    }));
    h.onModel(() => ({ tool: "report", args: { status: "done", text: "The job succeeded" } }));
    worker();
    await until(() => (existsSync(accepted) ? true : undefined), "Herdr to accept the dispatch");
    const result = await untilAsync(
      async () =>
        (await cardView()).entries.find(
          (entry) => entry.kind === "job-result" && entry.fields["exitCode"] === code,
        ),
      "the command's durable result",
    );
    await h.waitFor(
      (event) => event["type"] === "fleet_delivered" && event["entryId"] === result.id,
      "the exact successful result to reach the worker before the pane reply",
    );
    writeFileSync(release, "");
    await h.waitForCall(1);
    assert.ok(said("Started job 1 (quick) in tab job-1-quick."));
    await until(
      () => (said(`job 1 (quick) exited ${String(code)}: finished-before-ack`) ? true : undefined),
      "the successful result in the model's context",
    );
    assert.deepEqual(await jobResults(), [[1, code, "finished-before-ack"]]);
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
  const dispatches = join(jobDir, "dispatches");
  shim(
    (herdr) => `#!/bin/sh
if [ "$1 $2" = 'pane run' ]; then
  response=$(${quote(herdr)} "$@") || exit "$?"
  echo dispatch >> ${quote(dispatches)}
  echo 'pane reply unavailable' >&2
  exit 1
fi
exec ${quote(herdr)} "$@"
`,
  );
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
