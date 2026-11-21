import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { CardViewSchema, check } from "@fleet/protocol";
import { quote } from "@fleet/protocol/route";
import { JobLab } from "../support/job-lab.ts";
import { until } from "../support/live-fleet.ts";

const OTHER_LAUNCH = "11111111-1111-4111-8111-111111111111";
const EXPIRED = [[1, 127, "could not start: wrapper did not register before the startup deadline"]];

let jl: JobLab;
beforeEach(async () => {
  jl = await JobLab.start();
});
afterEach(async (t) => {
  await jl.stop(t);
});

const settleWindow = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 1000));

test("incomplete or unbound startup fences leave the wait, wrapper input, and tab alone until cardd's expiry fences the real launch", async (t) => {
  const { proxy, shim, input, launch, tab } = await jl.holdDispatch(t, "echo gate");
  const fence = { job: 1, exitCode: 127, startupFenced: true, startupLaunch: launch };
  const variants: Record<string, unknown>[] = [
    { ...fence, startupLaunch: undefined },
    { ...fence, startupLaunch: OTHER_LAUNCH },
    { ...fence, startupLaunch: 7 },
    { ...fence, startupLaunch: "not-a-launch" },
    { ...fence, startupFenced: "true" },
    { ...fence, startupFenced: undefined },
    { ...fence, exitCode: undefined },
    { ...fence, exitCode: 1.5 },
    { ...fence, lost: true },
    { ...fence, revived: true },
    { ...fence, job: 2 },
    { ...fence, job: 0 },
    { ...fence, job: 1.5 },
  ];
  const before = jl.deliveredCount();
  const mark = proxy.activities.length;
  variants.forEach((fields, index) => proxy.push(1001 + index, fields));
  await jl.h.waitForNth(
    (event) => event["type"] === "fleet_delivered",
    before + variants.length,
    "the invalid fences",
  );
  await settleWindow();
  assert.equal(existsSync(shim.closes), false);
  assert.ok(existsSync(input));
  assert.ok(await jl.hasTab(tab));
  assert.equal(proxy.activities.slice(mark).includes("idle"), false);

  jl.expireJob();
  await until(
    () => (existsSync(shim.closes) ? readFileSync(shim.closes, "utf8").trim() : undefined),
    "cardd's real expiry fence to close the tab",
  );
  assert.equal(readFileSync(shim.closes, "utf8").trim(), tab);
  assert.equal(existsSync(input), false);
  await until(async () => ((await jl.hasTab(tab)) ? undefined : true), "the fenced tab to close");
  assert.deepEqual(await jl.jobResults(), EXPIRED);
});

test("a matching or unbound startup fence cannot end a registered job's wait after a job list confirmed registration", async (t) => {
  const done = join(jl.jobDir, "gate-done");
  const { proxy, shim, launch, tab } = await jl.holdDispatch(
    t,
    `while [ ! -e ${quote(done)} ]; do sleep 0.05; done; echo gate`,
  );
  writeFileSync(shim.release, "");
  await until(() => (jl.wrapperPid() === null ? undefined : true), "the wrapper to register");
  const lists = proxy.lists();
  proxy.drop();
  await until(
    () => (proxy.lists() > lists ? true : undefined),
    "the reconnect job list to confirm registration",
  );
  const delivered = jl.deliveredCount();
  const mark = proxy.activities.length;
  const fence = { job: 1, exitCode: 127, startupFenced: true };
  proxy.push(1001, { ...fence, startupLaunch: OTHER_LAUNCH });
  proxy.push(1002, { ...fence, job: 2, startupLaunch: launch });
  proxy.push(1003, { ...fence, startupLaunch: launch });
  await jl.h.waitForNth(
    (event) => event["type"] === "fleet_delivered",
    delivered + 3,
    "the contradictory fences",
  );
  await settleWindow();
  assert.equal(proxy.activities.slice(mark).includes("idle"), false);
  assert.equal(existsSync(shim.closes), false);
  assert.ok(await jl.hasTab(tab));

  writeFileSync(done, "");
  await until(
    () => (proxy.activities.slice(mark).includes("idle") ? true : undefined),
    "the real job result to end the wait",
  );
  assert.deepEqual(await jl.jobResults(), [[1, 0, "gate"]]);
});

test("an early expiry fence is not displaced by incomplete or other-job fences before the prepare receipt arrives", async (t) => {
  const proxy = await jl.proxy(t);
  const prepare = proxy.holdPrepare();
  const shim = jl.installShim();
  jl.h.onModel(() => ({ tool: "run_long", args: { label: "gate", command: "echo gate" } }));
  jl.h.onModel(() => ({ text: "The launch was fenced" }));
  jl.worker();
  const launch = await prepare.reached;
  jl.expireJob();
  const fence = await until(
    async () =>
      check(CardViewSchema, await jl.fleet.main.call("card", { card: jl.card.id })).entries.find(
        (entry) => entry.fields["startupFenced"] === true,
      ),
    "cardd to commit the expiry fence",
  );
  await jl.h.waitFor(
    (event) => event["type"] === "fleet_delivered" && event["entryId"] === fence.id,
    "the genuine early fence",
  );
  const delivered = jl.deliveredCount();
  const complete = { exitCode: 127, startupFenced: true, startupLaunch: launch };
  proxy.push(2001, { ...complete, job: 1, exitCode: undefined });
  proxy.push(2002, { ...complete, job: 2 });
  await jl.h.waitForNth(
    (event) => event["type"] === "fleet_delivered",
    delivered + 2,
    "the competing fences",
  );
  prepare.release();
  await jl.h.waitForCall(2);
  assert.ok(
    jl.h.calls.some((turns) => turns.some((turn) => turn.text.includes("Job 1 cannot start:"))),
  );
  assert.equal(existsSync(shim.creates), false);
  assert.equal(existsSync(shim.runs), false);
  assert.deepEqual(await jl.jobResults(), EXPIRED);
});

const matching = (launch: string) => ({
  job: 1,
  exitCode: 127,
  startupFenced: true,
  startupLaunch: launch,
});

test("a genuine registered-wrapper loss retires fence eligibility even when the exact read fails", async (t) => {
  const done = join(jl.jobDir, "gate-done");
  const { proxy, shim, launch, tab } = await jl.holdDispatch(
    t,
    `while [ ! -e ${quote(done)} ]; do sleep 0.05; done; echo gate`,
  );
  writeFileSync(shim.release, "");
  await until(() => (jl.wrapperPid() === null ? undefined : true), "the wrapper to register");
  proxy.callFault("job.running", { error: "injected exact read failure" });
  const mark = proxy.activities.length;
  const wrapper = Number(jl.wrapperPid());
  process.kill(wrapper, "SIGSTOP");
  const resume = (): void => {
    try {
      process.kill(wrapper, "SIGCONT");
    } catch {
      return;
    }
  };
  t.after(resume);
  const lost = await until(
    async () =>
      check(CardViewSchema, await jl.fleet.main.call("card", { card: jl.card.id })).entries.find(
        (entry) => entry.fields["lost"] === true,
      ),
    "the detector to report the silent wrapper",
  );
  await jl.h.waitFor(
    (event) => event["type"] === "fleet_delivered" && event["entryId"] === lost.id,
    "the loss notice",
  );
  const delivered = jl.deliveredCount();
  proxy.push(1001, matching(launch));
  await jl.h.waitForNth(
    (event) => event["type"] === "fleet_delivered",
    delivered + 1,
    "the contradictory fence",
  );
  await settleWindow();
  assert.equal(existsSync(shim.closes), false);
  assert.ok(await jl.hasTab(tab));
  assert.equal(proxy.activities.slice(mark).includes("idle"), false);

  proxy.callFault("job.running", undefined);
  resume();
  writeFileSync(done, "");
  await until(
    () => (proxy.activities.slice(mark).includes("idle") ? true : undefined),
    "the real result to end the wait",
  );
  assert.ok((await jl.jobResults()).some((row) => row[0] === 1 && row[1] === 0));
});

test("a running stop receipt for a modern launch retires fence eligibility", async (t) => {
  jl.env["PROBE_STOP_RESULT"] = "1";
  const done = join(jl.jobDir, "gate-done");
  const { pi, proxy, shim, launch, tab } = await jl.holdDispatch(
    t,
    `while [ ! -e ${quote(done)} ]; do sleep 0.05; done; echo gate`,
    true,
  );
  writeFileSync(shim.release, "");
  await until(() => (jl.wrapperPid() === null ? undefined : true), "the wrapper to register");
  const mark = proxy.activities.length;
  jl.h.onModel(() => ({ tool: "stop_job", args: { job: 1 } }));
  jl.h.onModel(() => ({ text: "The stop was sent" }));
  pi.prompt("Stop the gate job");
  const stopped = await jl.h.waitFor(
    (event) => event["type"] === "stop_result",
    "the running stop receipt",
  );
  assert.equal(stopped["isError"], false);
  const delivered = jl.deliveredCount();
  proxy.push(1001, matching(launch));
  await jl.h.waitForNth(
    (event) => event["type"] === "fleet_delivered",
    delivered + 1,
    "the contradictory fence",
  );
  await settleWindow();
  assert.equal(existsSync(shim.closes), false);
  assert.ok(await jl.hasTab(tab));
  assert.equal(proxy.activities.slice(mark).includes("idle"), false);

  writeFileSync(done, "");
  await until(
    () => (proxy.activities.slice(mark).includes("idle") ? true : undefined),
    "the real result to end the wait",
  );
  assert.deepEqual(await jl.jobResults(), [[1, 0, "gate"]]);
});
