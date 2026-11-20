import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { CardViewSchema, check, HttpOutcomeSchema, OPS, VersionSchema } from "@fleet/protocol";
import { quote } from "@fleet/protocol/route";
import { Cardd } from "../support/cardd.ts";
import { toolResults } from "../support/dispatch-lab.ts";
import { begin, newCard } from "../support/fleet.ts";
import { Harness } from "../support/harness.ts";
import { HerdrLab } from "../support/herdr.ts";
import { parseRecord, records } from "../support/json.ts";
import { until } from "../support/live-fleet.ts";
import { groupIdentity, signalOwnedGroup } from "../support/marked.ts";
import { ownWorkspacePackages } from "../support/protocol-skew.ts";
import { addRemote, git, tip } from "../support/remote.ts";
import { configureMain, Scratch } from "../support/scratch.ts";

const LEGACY = "24ab0e4fb66d84ef8b5a8b802c3426d8fcc2aefd";
const REPO = fileURLToPath(new URL("../..", import.meta.url));
const EXTENSION = "packages/extension/src/index.ts";
const READY = { state: "ready", blockers: [] };

let workerCode: Scratch;
let daemonCode: Scratch;
let h: Harness;
let lab: HerdrLab;
let cardd: Cardd;
let next: string;
let mainToken: string;

beforeEach(async () => {
  workerCode = new Scratch("worker-code");
  daemonCode = new Scratch("daemon-code");
  const tree = git(workerCode.root, "rev-parse", "HEAD^{tree}");
  git(workerCode.root, "fetch", "-q", REPO, LEGACY);
  const base = tip(workerCode.root, "FETCH_HEAD");
  next = git(workerCode.root, "commit-tree", tree, "-p", base, "-m", "Stage job cutover");
  git(workerCode.root, "reset", "-q", "--hard", base);
  const remote = addRemote(workerCode.root);
  git(daemonCode.root, "remote", "add", "origin", remote);
  git(daemonCode.root, "fetch", "-q", "origin");
  git(daemonCode.root, "reset", "-q", "--hard", "origin/main");
  ownWorkspacePackages(workerCode.root);
  ownWorkspacePackages(daemonCode.root);
  h = await Harness.start();
  lab = await HerdrLab.start({});
  cardd = await Cardd.underKeepAlive(daemonCode.root);
  const admin = (...args: string[]) =>
    execFileSync(
      process.execPath,
      [join(daemonCode.root, "packages/cardd/src/main.ts"), ...args, "--db", cardd.db],
      { encoding: "utf8" },
    ).trim();
  mainToken = admin("lane", "add", "main", "--home", workerCode.root);
  admin(
    "project",
    "add",
    "web",
    "--clone",
    `local=${workerCode.root}`,
    "--delivery",
    "no-mistakes",
  );
  configureMain(workerCode, cardd.url, mainToken);
});

afterEach(async (t) => {
  await lab?.printIfFailed(t);
  const stopped = await Promise.allSettled([lab?.stop(), h?.stop(), cardd?.stop()]);
  workerCode?.dispose();
  daemonCode?.dispose();
  const failed = stopped.find((result) => result.status === "rejected");
  if (failed !== undefined) throw new Error(`cleanup failed: ${String(failed.reason)}`);
});

const version = () => cardd.url.replace(/^ws/, "http").replace(/\/session$/, "/api/version");
const cutover = (status: number, ...args: string[]) => {
  const result = spawnSync("node", [workerCode.launch, "job-cutover", ...args], {
    encoding: "utf8",
  });
  assert.equal(result.status, status, result.stderr || result.stdout);
  return check(OPS["job.cutover"].result, parseRecord(result.stdout));
};

function launch(label: string, command: string, agent = "default"): void {
  h.onModel(() => ({ tool: "run_long", args: { label, command } }), agent);
  h.onModel(() => ({ text: `acted on ${label}` }), agent);
}

const file = (path: string) => until(() => (existsSync(path) ? true : undefined), path);
const fleetConnected = (event: Record<string, unknown>): boolean =>
  event["type"] === "fleet_connected";
const waitResult = (card: number, job: number, code: number) =>
  until(
    async () => {
      const outcome = check(
        HttpOutcomeSchema,
        (await cardd.post(mainToken, "card", { card })).body,
      );
      assert.ok(outcome.ok);
      return check(CardViewSchema, outcome.value).entries.find(
        (entry) => entry.fields["job"] === job && entry.fields["exitCode"] === code,
      );
    },
    `job ${String(job)} to record exit ${String(code)}`,
  );

const waitGroupExit = (pid: number) =>
  until(
    () => {
      try {
        process.kill(-pid, 0);
        return undefined;
      } catch (error) {
        if (Reflect.get(Object(error), "code") !== "ESRCH") throw error;
        return true;
      }
    },
    `process group ${String(pid)} to exit`,
  );

const waitTabClosed = (workspace: string, job: number, label: string) =>
  until(async () => {
    const tabs = records((await lab.run(["tab", "list", "--workspace", workspace]))["tabs"]);
    return tabs.some((tab) => tab["label"] === `job-${String(job)}-${label}`) ? undefined : true;
  }, `${label} wrapper to close its tab`);

async function upgrade(): Promise<void> {
  const old = tip(workerCode.root);
  git(workerCode.root, "push", "-q", "origin", `${next}:refs/heads/main`);
  const workerUpdate = parseRecord(workerCode.fleet(["update"]));
  assert.equal(workerUpdate["state"], "updated", JSON.stringify(workerUpdate));
  assert.equal(workerUpdate["from"], old);
  assert.equal(tip(workerCode.root), next);
  assert.equal(tip(daemonCode.root), old);
}

async function upgradeDaemon(): Promise<void> {
  const old = tip(daemonCode.root);
  const args = [
    "cardd",
    "--root",
    daemonCode.root,
    "--db",
    cardd.db,
    "--running",
    old,
    "--restart",
    JSON.stringify(cardd.restartCommand),
  ];
  const daemonUpdate = parseRecord(daemonCode.fleet(args));
  assert.equal(daemonUpdate["state"], "updated", JSON.stringify(daemonUpdate));
  assert.equal(daemonUpdate["from"], old);
  assert.equal(tip(daemonCode.root), next);
  await until(async () => {
    const response = await fetch(version()).catch(() => undefined);
    if (response === undefined) return undefined;
    const served = check(VersionSchema, await response.json());
    return served.commit === next ? true : undefined;
  }, "the upgraded cardd to serve its exact commit");
}

test("an updated worker can stop its legacy job after reload against pre-registration cardd", async () => {
  const main = await cardd.connect(mainToken);
  const card = await newCard(main, "Stop a legacy job after reload");
  const token = await begin(main, card, "run the legacy job", "local");
  const created = await lab.run(["workspace", "create", "--no-focus"]);
  const workspace = records([created["workspace"]])[0]?.["workspace_id"];
  assert.equal(typeof workspace, "string");
  await upgrade();
  assert.equal(check(VersionSchema, await (await fetch(version())).json()).commit, LEGACY);
  const env = {
    ...lab.env,
    FLEET_URL: cardd.url,
    FLEET_TOKEN: token,
    FLEET_ROLE: "worker",
    HERDR_SESSION: lab.name,
    HERDR_WORKSPACE_ID: String(workspace),
  };
  const ready = join(h.dir, "legacy-ready");
  const run = `require('node:fs').writeFileSync(${JSON.stringify(ready)}, String(process.pid)); setInterval(() => {}, 1000)`;
  launch("legacy", `exec node -e ${quote(run)}`);
  const pi = h.startPi("c-1-a1", env, [join(workerCode.root, EXTENSION)]);
  await file(ready);
  await h.waitForNth((event) => event["type"] === "settled", 1, "the launch to settle");
  pi.prompt("/probe-reload");
  await h.waitForNth(fleetConnected, 2, "the updated worker to reconnect after reload");
  h.onModel(() => ({ tool: "stop_job", args: { job: 1 } }));
  h.onModel(() => ({ text: "Stop attempted" }));
  pi.prompt("Stop the legacy job");
  assert.match(toolResults(await h.waitForCall(3)).at(-1) ?? "", /Sent a stop to job 1 \(legacy\)/);
  assert.equal((await waitResult(card.id, 1, 130)).body, "interrupted");
  const pid = Number(readFileSync(ready, "utf8"));
  assert.ok(Number.isInteger(pid) && pid > 1);
  await waitGroupExit(pid);
  await waitTabClosed(String(workspace), 1, "legacy");
  const jobs = await cardd.post(token, "jobs", {});
  assert.deepEqual(check(HttpOutcomeSchema, jobs.body), { ok: true, value: [] });
});

test("old host and cardd CLIs pull the additive stage without stranding either legacy wrapper; seal blocks until confirmed drain", async () => {
  const main = await cardd.connect(mainToken);
  const card = await newCard(main, "Drain the old wrappers");
  const token = await begin(main, card, "keep the old wrapper running", "local");
  const created = await lab.run(["workspace", "create", "--no-focus"]);
  const workspace = records([created["workspace"]])[0]?.["workspace_id"];
  assert.equal(typeof workspace, "string");
  const env = {
    ...lab.env,
    FLEET_URL: cardd.url,
    FLEET_TOKEN: token,
    FLEET_ROLE: "worker",
    HERDR_SESSION: lab.name,
    HERDR_WORKSPACE_ID: String(workspace),
  };
  const natural = join(h.dir, "natural-ready");
  const go = join(h.dir, "natural-go");
  const interrupt = join(h.dir, "interrupt-ready");
  const never = join(h.dir, "never");
  const ownedLaunch = lab.owned["FLEET_E2E_DETACH"];
  assert.ok(ownedLaunch);
  const helper = `require('node:fs').writeFileSync(${JSON.stringify(natural)}, String(process.pid)); setInterval(() => {}, 1000)`;
  const helperArgs = JSON.stringify([ownedLaunch, "node", "-e", helper]);
  const startHelper = `require('node:child_process').spawn(process.execPath, ${helperArgs}, { detached: true, stdio: 'ignore' }).unref()`;
  launch(
    "natural",
    `node -e ${quote(startHelper)} && { while [ ! -f ${quote(go)} ]; do sleep 0.1; done; echo drained; exit 17; }`,
  );
  const pi = h.startPi("c-1-a1", env, [join(workerCode.root, EXTENSION)]);
  await file(natural);
  await h.waitForCall(1);
  await upgrade();

  const waitScript = `require('node:fs').writeFileSync(${JSON.stringify(interrupt)}, String(process.pid)); setInterval(() => {}, 1000)`;
  launch("interrupt", `exec node -e ${quote(waitScript)}`);
  pi.prompt("Launch with the older worker code after the pull");
  await file(interrupt);
  await h.waitForCall(3);
  const beforeUpgrade = h.events.filter(fleetConnected).length;
  await upgradeDaemon();
  await h.waitForNth(fleetConnected, beforeUpgrade + 1, "the older worker to reconnect");

  assert.equal(cutover(1, "status").state, "open");
  const sealed = cutover(1, "seal");
  assert.equal(sealed.state, "draining");
  assert.deepEqual(
    sealed.blockers.map(({ label, state }) => [label, state]),
    [
      ["natural", "running"],
      ["interrupt", "running"],
    ],
  );
  const [first, second] = sealed.blockers;
  assert.ok(first && second);
  launch("refused", `touch ${quote(never)}`);
  pi.prompt("Try to admit one more legacy job after the seal");
  assert.match(toolResults(await h.waitForCall(5)).at(-1) ?? "", /Legacy job launches are sealed/);
  assert.equal(existsSync(never), false);

  writeFileSync(go, "");
  assert.equal((await waitResult(card.id, first.job, 17)).body, "drained");
  await waitTabClosed(workspace, first.job, first.label);
  const helperPid = Number(readFileSync(natural, "utf8"));
  const helperIdentity = groupIdentity(helperPid);
  assert.ok(helperIdentity, "the detached helper survived its wrapper and command");
  assert.deepEqual(
    cutover(1, "status").blockers.map(({ job, state }) => [job, state]),
    [
      [first.job, "finished"],
      [second.job, "running"],
    ],
  );
  h.onModel(() => ({ tool: "stop_job", args: { job: second.job } }));
  h.onModel(() => ({ text: "stop sent" }));
  pi.prompt("Stop the other legacy job");
  await waitResult(card.id, second.job, 130);
  const pid = Number(readFileSync(interrupt, "utf8"));
  assert.ok(Number.isInteger(pid) && pid > 1);
  await waitGroupExit(pid);
  await waitTabClosed(workspace, second.job, second.label);
  const remaining = cutover(
    1,
    "confirm-stop",
    String(second.job),
    "Verified the only command process group exited and the wrapper closed its tab after stop_job",
  );
  assert.equal(remaining.state, "draining");
  assert.deepEqual(
    remaining.blockers.map(({ job, state }) => [job, state]),
    [[first.job, "finished"]],
  );
  assert.equal(groupIdentity(helperPid), helperIdentity);
  assert.ok(signalOwnedGroup(helperPid, helperIdentity, "SIGTERM"));
  await waitGroupExit(helperPid);
  assert.deepEqual(
    cutover(
      0,
      "confirm-stop",
      String(first.job),
      "Verified the foreground command and wrapper exited, then stopped and verified the only detached helper's group was gone",
    ),
    READY,
  );

  await pi.kill();
  const beforeFresh = h.events.filter(fleetConnected).length;
  launch("registered", "echo from-the-new-wrapper", "fresh");
  const fresh = h.startPi("c-1-a1", { ...env, FLEET_FAKE_AGENT: "fresh" }, [
    join(workerCode.root, EXTENSION),
  ]);
  await h.waitForNth(fleetConnected, beforeFresh + 1, "the new worker to connect");
  fresh.prompt("Run a registered job after handover");
  assert.equal((await waitResult(card.id, second.job + 1, 0)).body, "from-the-new-wrapper");
  assert.deepEqual(cutover(0, "status"), READY);
  const legacy = await cardd.post(token, "job.start", {
    label: "no-loophole",
    command: "true",
    launch: crypto.randomUUID(),
  });
  assert.equal(legacy.status, 400);
  const denied = check(HttpOutcomeSchema, legacy.body);
  assert.equal(denied.ok, false);
});
