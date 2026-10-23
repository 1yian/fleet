import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { CardSchema, check, type Card, type Entry } from "@fleet/protocol";
import { begin, startFleet, type Fleet } from "../support/fleet.ts";
import { FakeNoMistakes } from "../support/fake-no-mistakes.ts";
import { Harness, type Pi, type Turn } from "../support/harness.ts";
import { HerdrLab } from "../support/herdr.ts";
import { records } from "../support/json.ts";

const EXTENSION = fileURLToPath(new URL("../../packages/extension/src/index.ts", import.meta.url));
const SHELL = fileURLToPath(new URL("../support/shell-tool.ts", import.meta.url));
const INTENT = "make the scrollbar single";

let fleet: Fleet;
let h: Harness;
let lab: HerdrLab;
let nm: FakeNoMistakes;
let env: Record<string, string>;
let card: Card;

beforeEach(async () => {
  fleet = await startFleet({ CARDD_TIMING_SCALE: "0.04" });
  h = await Harness.start();
  lab = await HerdrLab.start({});
  nm = new FakeNoMistakes(h.dir);
  const created = await lab.run(["workspace", "create", "--no-focus"]);
  const [workspace] = records([created["workspace"]]).map((each) => each["workspace_id"]);
  if (typeof workspace !== "string") throw new Error("the lab returned no workspace");
  card = check(
    CardSchema,
    await fleet.main.call("card.new", {
      title: "Users see one scrollbar",
      kind: "ship",
      project: "web",
      intent: INTENT,
    }),
  );
  const token = await begin(fleet.main, card, "fix it\n\nDelivery: no-mistakes");
  const jobDir = join(h.dir, "jobs");
  mkdirSync(jobDir);
  env = {
    FLEET_URL: fleet.cardd.url,
    FLEET_TOKEN: token,
    FLEET_ROLE: "worker",
    HERDR_SESSION: lab.name,
    HERDR_WORKSPACE_ID: workspace,
    TMPDIR: jobDir,
    FLEET_VALIDATE_PROBES_MS: "0",
    ...nm.env(process.env["PATH"] ?? ""),
  };
});
afterEach(async (t) => {
  await lab.printIfFailed(t);
  const stopped = await Promise.allSettled([lab.stop(), h.stop(), fleet.cardd.stop()]);
  const failed = stopped.find((result) => result.status === "rejected");
  if (failed !== undefined) throw new Error(`cleanup failed: ${String(failed.reason)}`);
});

const worker = (): Pi => h.startPi("c-1-a1", env, [EXTENSION, SHELL]);
const said = (text: string): boolean =>
  h.calls.some((turns) => turns.some((turn) => turn.text.includes(text)));
const lastUser = (turns: Turn[]): string | undefined =>
  turns.findLast((turn) => turn.role === "user")?.text;
async function settledOn(text: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!said(text)) {
    if (Date.now() > deadline) throw new Error(`the worker never saw: ${text}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
const isFailure = (entry: Entry): boolean => entry.fields["condition"] === "validation-failed";
const failures = (): Entry[] =>
  fleet.main.entries.map((push) => push.entry).filter((entry) => isFailure(entry));
const reruns = (): string[] => nm.calls().filter((call) => call.startsWith("rerun"));

const failedRun = (run: string, error: string): string =>
  `launch_receipt:\n  run_id: ${run}\n  disposition: created\nrun:\n  id: ${run}\n  status: failed\noutcome: failed\nerror: "${error}"`;
const gateAt = (run: string): string =>
  `run:\n  id: ${run}\n  status: running\ngate:\n  step: review\n  status: awaiting_approval`;

function validateThenBlock(): void {
  h.onModel(() => ({ tool: "validate", args: {} }));
  h.onModel(() => ({ text: "the pipeline is running" }));
  h.onModel(() => ({ tool: "report", args: { status: "blocked", text: "pipeline failed" } }));
}

async function failFirstRun(): Promise<Entry> {
  nm.answer(
    failedRun("RUN1", "pi reported error: Codex error: The usage limit has been reached"),
    1,
  );
  validateThenBlock();
  worker();
  const heard = await fleet.main.waitForEntry(isFailure, "the failed run to reach the parent");
  await h.waitForCall(2);
  return heard;
}

test("a failed run tells the direct parent once with the run, the cause, and a class", async () => {
  const heard = await failFirstRun();

  assert.equal(heard.kind, "finding");
  assert.match(
    heard.body,
    /^validation failed: the no-mistakes pipeline of c-1 stopped \(run RUN1,/,
  );
  assert.match(heard.body, /Class: quota\. Error: pi reported error: Codex error: The usage limit/);
  assert.match(heard.body, /Fleet does not rerun by itself/);
  assert.equal(heard.fields["run"], "RUN1");
  assert.equal(heard.fields["class"], "quota");
  assert.deepEqual(nm.calls(), [`axi run --launch-nonce c1-a1-v1 --intent ${INTENT} --wait 5m`]);
  assert.equal(failures().length, 1);
  assert.match(lastUser(h.calls[2] ?? []) ?? "", /job 1 \(validate\) exited 1/);
  assert.equal((await fleet.cardd.board()).cards.length, 1);
});

test("a revalidate reruns on the same card and keeps the history, and a repeat does not rerun again", async () => {
  const heard = await failFirstRun();
  const generation = Number(heard.fields["generation"]);
  nm.answer(gateAt("RERUN1"));
  h.onModel(() => ({ text: "the rerun reached a gate" }));

  const first = await fleet.main.call("validation.revalidate", {
    validation: Number(heard.fields["validation"]),
    generation,
    key: "k1",
  });
  await settledOn("job 2 (validate) exited 0");

  assert.deepEqual(first, { validation: 2, previous: 1, card: 1, attempts: 1, repeat: false });
  assert.deepEqual(reruns(), ["rerun"]);
  assert.ok(said("gate:\n  step: review"));

  const again = await fleet.main.call("validation.revalidate", {
    validation: 1,
    generation,
    key: "k1",
  });
  assert.deepEqual(again, { validation: 2, previous: 1, card: 1, attempts: 1, repeat: true });
  await assert.rejects(
    fleet.main.call("validation.revalidate", { validation: 1, generation, key: "k2" }),
    /already has a revalidation \(validation 2\)/,
  );
  assert.deepEqual(reruns(), ["rerun"]);
  assert.equal(failures().length, 1);
  const view = check(
    CardSchema,
    (await fleet.cardd.board()).cards.find((each) => each.id === 1) ?? {},
  );
  assert.equal(view.id, card.id);
  assert.equal((await fleet.cardd.board()).cards.length, 1);
});

test("a revalidate is refused for a stale generation and after the card's third", async () => {
  const heard = await failFirstRun();
  const generation = Number(heard.fields["generation"]);
  await assert.rejects(
    fleet.main.call("validation.revalidate", {
      validation: 1,
      generation: generation + 5,
      key: "x",
    }),
    /name \d+ to revalidate/,
  );

  let failed = 1;
  for (let round = 1; round <= 3; round += 1) {
    nm.answer(failedRun(`RERUN${String(round)}`, "agent timed out"), 1);
    await fleet.main.call("validation.revalidate", {
      validation: failed,
      generation,
      key: `r${String(round)}`,
    });
    const next = await fleet.main.waitForEntry(
      (entry) => isFailure(entry) && entry.fields["run"] === `RERUN${String(round)}`,
      `the failure of revalidation ${String(round)}`,
    );
    failed = Number(next.fields["validation"]);
    await h.waitForCall(2 + round);
    if (round < 3) h.onModel(() => ({ text: "noted" }));
  }
  await assert.rejects(
    fleet.main.call("validation.revalidate", { validation: failed, generation, key: "r4" }),
    /all 3 revalidations/,
  );
  assert.equal(reruns().length, 3);
});

test("a down daemon is reported to the parent and the daemon is never started or restarted", async () => {
  nm.daemonDown();
  nm.answer("error: connect to daemon: dial unix /run/no-mistakes.sock: connection refused", 1);
  validateThenBlock();
  worker();
  const heard = await fleet.main.waitForEntry(isFailure, "the daemon outage to reach the parent");
  await h.waitForCall(2);

  assert.equal(heard.fields["class"], "daemon-down");
  assert.match(heard.body, /Class: daemon-down\./);
  assert.match(heard.body, /Fleet does not start or restart the daemon\./);
  assert.equal(failures().length, 1);
  assert.equal(nm.daemonTouched, false);
  assert.deepEqual(
    nm.calls().filter((call) => call.startsWith("daemon")),
    [],
  );
});

test("a worker is refused a daemon admin command and a hand-driven run", async () => {
  h.onModel(() => ({ tool: "bash", args: { command: "no-mistakes daemon restart --force" } }));
  h.onModel(() => ({ tool: "bash", args: { command: "cd . && no-mistakes axi run --wait 5m" } }));
  h.onModel(() => ({
    tool: "run_long",
    args: { label: "nm", command: "no-mistakes daemon stop" },
  }));
  h.onModel(() => ({ text: "refused all three" }));
  worker();
  await h.waitForCall(3);

  assert.match(JSON.stringify(h.calls[1]), /refused: the no-mistakes daemon is shared/);
  assert.match(
    JSON.stringify(h.calls[2]),
    /refused: drive the no-mistakes run with the validate tool/,
  );
  assert.match(JSON.stringify(h.calls[3]), /refused: the no-mistakes daemon is shared/);
  assert.deepEqual(nm.calls(), []);
  assert.equal(nm.daemonTouched, false);
  assert.equal(said("Started job"), false);
});

test("a mate is refused a daemon admin command", async () => {
  h.onModel(() => ({ tool: "bash", args: { command: "no-mistakes daemon restart --force" } }));
  h.onModel(() => ({ text: "refused" }));
  h.startPi(
    "main-mate",
    {
      FLEET_URL: fleet.cardd.url,
      FLEET_TOKEN: fleet.mainToken,
      FLEET_ROLE: "mate",
      ...nm.env(process.env["PATH"] ?? ""),
    },
    [EXTENSION, SHELL],
  );
  await h.waitForCall(1);

  assert.match(JSON.stringify(h.calls[1]), /refused: the no-mistakes daemon is shared/);
  assert.deepEqual(nm.calls(), []);
  assert.equal(nm.daemonTouched, false);
});
