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
  launch(
    "natural",
    `touch ${quote(natural)}; while [ ! -f ${quote(go)} ]; do sleep 0.1; done; echo drained; exit 17`,
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
  await upgradeDaemon();

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
  assert.deepEqual(
    cutover(1, "status").blockers.map(({ job }) => job),
    [second.job],
  );
  h.onModel(() => ({ tool: "stop_job", args: { job: second.job } }));
  h.onModel(() => ({ text: "stop sent" }));
  pi.prompt("Stop the other legacy job");
  await waitResult(card.id, second.job, 130);
  assert.deepEqual(
    cutover(1, "status").blockers.map(({ job }) => job),
    [second.job],
  );
  const pid = Number(readFileSync(interrupt, "utf8"));
  assert.ok(Number.isInteger(pid) && pid > 1);
  await until(() => {
    try {
      process.kill(-pid, 0);
      return undefined;
    } catch (error) {
      if (Reflect.get(Object(error), "code") !== "ESRCH") throw error;
      return true;
    }
  }, "the stopped command process group to exit");
  await until(async () => {
    const tabs = records(
      (await lab.run(["tab", "list", "--workspace", String(workspace)]))["tabs"],
    );
    return tabs.some((tab) => tab["label"] === `job-${String(second.job)}-interrupt`)
      ? undefined
      : true;
  }, "the stopped wrapper to close its tab");
  assert.deepEqual(
    cutover(
      0,
      "confirm-stop",
      String(second.job),
      "Verified the command process group exited and the wrapper closed its tab after stop_job",
    ),
    READY,
  );

  await pi.kill();
  launch("registered", "echo from-the-new-wrapper", "fresh");
  const fresh = h.startPi("c-1-a1", { ...env, FLEET_FAKE_AGENT: "fresh" }, [
    join(workerCode.root, EXTENSION),
  ]);
  await fresh.state();
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
