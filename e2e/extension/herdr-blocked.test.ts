import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { CardSchema, CardViewSchema, check, OPS } from "@fleet/protocol";
import { Cardd } from "../support/cardd.ts";
import { Harness } from "../support/harness.ts";
import { HerdrLab } from "../support/herdr.ts";
import { isRecord } from "../support/json.ts";
import { configureMain, mateArgs, Scratch, startMain } from "../support/scratch.ts";

const WAIT_MS = 60_000;
const BIN = fileURLToPath(new URL("../../node_modules/.bin", import.meta.url));

let cardd: Cardd;
let h: Harness;
let lab: HerdrLab;
let here: Scratch;
let ghostToken: string;
beforeEach(async () => {
  cardd = await Cardd.start();
  h = await Harness.start();
  mkdirSync(join(h.dir, "agent", "extensions"), { recursive: true });
  execFileSync("herdr", ["integration", "install", "pi"], {
    env: { ...process.env, PI_CODING_AGENT_DIR: join(h.dir, "agent") },
  });
  here = new Scratch();
  configureMain(here, cardd.url, cardd.addLane("main", undefined, here.root));
  ghostToken = cardd.addLane("ghost", "main");
  lab = await HerdrLab.start({ ...h.piEnv("mate"), PATH: `${BIN}:${process.env["PATH"] ?? ""}` });
});
afterEach(async (t) => {
  await lab.printIfFailed(t);
  const stopped = await Promise.allSettled([lab.stop(), h.stop(), cardd.stop()]);
  here.dispose();
  const failed = stopped.find((result) => result.status === "rejected");
  if (failed !== undefined) throw new Error(`cleanup failed: ${String(failed.reason)}`);
});

async function agentOf(pane: string): Promise<{ status: string }> {
  const got = await lab.run(["pane", "get", pane]);
  const info = isRecord(got["pane"]) ? got["pane"] : {};
  return { status: String(info["agent_status"]) };
}

async function until(
  pane: string,
  what: string,
  done: (state: { status: string }) => boolean,
): Promise<{ status: string }> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const state = await agentOf(pane);
    if (done(state)) return state;
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}: ${JSON.stringify(state)}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

async function wake(name: string): Promise<void> {
  const ghost = await cardd.connect(ghostToken);
  const card = check(CardSchema, await ghost.call("card.new", { title: name, kind: "scout" }));
  await ghost.call("hold", { card: card.id, question: "ok?", options: ["Yes"] });
  await ghost.close();
}

test("a worker with an owed handoff shows blocked until it reports completion", async () => {
  cardd.addProject("web", { maverick: here.root });
  const mate = await cardd.connect(ghostToken);
  const card = check(
    CardSchema,
    await mate.call("card.new", { title: "handoff", kind: "scout", project: "web" }),
  );
  const { token } = check(
    OPS["attempt.begin"].result,
    await mate.call("attempt.begin", { card: card.id, host: "maverick", task: "investigate" }),
  );
  h.onModel(
    () => ({ tool: "report", args: { status: "blocked", text: "missing access" } }),
    "mate",
  );
  h.onModel(() => ({ text: "waiting" }), "mate");
  let reply = "";
  h.onModel((turns) => {
    reply = /reply owed, (r-\d+)/.exec(turns.at(-1)?.text ?? "")?.[1] ?? "";
    return {
      tool: "report",
      args: {
        status: "paused",
        text: "waiting without answering",
        until: new Date(Date.now() + 3_600_000).toISOString(),
      },
    };
  }, "mate");
  h.onModel(() => ({ text: "waiting for the next message" }), "mate");
  h.onModel(
    () => ({ tool: "report", args: { status: "done", text: "report written", replyTo: reply } }),
    "mate",
  );
  h.onModel(() => ({ text: "finished" }), "mate");
  const pane = await startMain(lab, here, h, false, [
    ...mateArgs(h),
    "--fleet-url",
    cardd.url,
    "--fleet-token",
    token,
    "--fleet-role",
    "worker",
  ]);
  await until(pane, "an owed handoff to block the worker", (s) => s.status === "blocked");
  const blocked = await mate.waitForEntry((entry) => entry.kind === "report", "the blocked report");
  assert.equal(blocked.body, "missing access");
  await mate.call("comment", { card: card.id, text: "Which port?", reply: true });
  await h.waitForNth(
    (event) => event["type"] === "settled" && event["aborted"] === false,
    2,
    "the unanswered turn to settle",
  );
  assert.equal((await agentOf(pane)).status, "blocked");
  assert.match(reply, /^r-\d+$/);
  await mate.call("comment", { card: card.id, text: "access restored, answer now" });
  await mate.waitForEntry((entry) => entry.fields["status"] === "done", "the completed report");
  assert.equal(
    (await until(pane, "the obligation to clear", (s) => s.status === "idle")).status,
    "idle",
  );
});

test("a mate whose turn failed reads blocked in herdr with the cause, and the next good turn clears it", async () => {
  h.onModel(() => ({ fail: "You exceeded your current quota, please check your plan" }), "mate");
  h.onModel(() => ({ text: "all well" }), "mate");
  const pane = await startMain(lab, here, h);
  await until(pane, "the mate to settle idle", (s) => s.status === "idle");

  await wake("first");
  await until(pane, "blocked", (s) => s.status === "blocked");
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal((await agentOf(pane)).status, "blocked");

  await wake("second");
  await until(pane, "idle after a good turn", (s) => s.status === "idle");
});

test("a worker whose owed reply was answered elsewhere stops reading blocked on its next turn", async () => {
  cardd.addProject("web", { maverick: here.root });
  const mate = await cardd.connect(ghostToken);
  const card = check(
    CardSchema,
    await mate.call("card.new", { title: "stale reply", kind: "scout", project: "web" }),
  );
  const { token } = check(
    OPS["attempt.begin"].result,
    await mate.call("attempt.begin", { card: card.id, host: "maverick", task: "investigate" }),
  );
  const pause = {
    tool: "report",
    args: {
      status: "paused",
      text: "waiting",
      until: new Date(Date.now() + 3_600_000).toISOString(),
    },
  };
  for (const text of ["waiting", "noted the question", "noted the update"]) {
    h.onModel(() => pause, "mate");
    h.onModel(() => ({ text }), "mate");
  }
  const pane = await startMain(lab, here, h, false, [
    ...mateArgs(h),
    "--fleet-url",
    cardd.url,
    "--fleet-token",
    token,
    "--fleet-role",
    "worker",
  ]);
  await until(pane, "the worker to settle idle", (s) => s.status === "idle");
  await mate.call("comment", { card: card.id, text: "Which port?", reply: true });
  await until(pane, "the owed reply to block the worker", (s) => s.status === "blocked");
  const asked = check(CardViewSchema, await mate.call("card", { card: card.id })).card.replies[0];
  assert.ok(asked, "the ask is open on the card");
  const worker = await cardd.connect(token);
  await worker.call("report", {
    status: "working",
    text: "port 8080",
    replyTo: asked.id,
  });
  await worker.close();
  await mate.call("comment", { card: card.id, text: "thanks, carry on" });
  assert.equal(
    (await until(pane, "the answered reply to stop blocking", (s) => s.status === "idle")).status,
    "idle",
  );
});

const CLEARS: readonly {
  readonly name: string;
  readonly clear: (mate: Awaited<ReturnType<Cardd["connect"]>>, card: number) => Promise<unknown>;
}[] = [
  {
    name: "the mate resolving the key",
    clear: (mate, card) =>
      mate.call("comment", { card, text: "Haiku is enabled", resolves: "enable" }),
  },
  {
    name: "the mate clearing the hold with a note",
    clear: (mate, card) => mate.call("release", { card, note: "settled elsewhere" }),
  },
];

for (const { name, clear } of CLEARS) {
  test(`a worker waiting on a decision stops reading blocked once ${name}`, async () => {
    cardd.addProject("web", { maverick: here.root });
    const mate = await cardd.connect(ghostToken);
    const card = check(
      CardSchema,
      await mate.call("card.new", { title: "decision", kind: "scout", project: "web" }),
    );
    const { token } = check(
      OPS["attempt.begin"].result,
      await mate.call("attempt.begin", { card: card.id, host: "maverick", task: "investigate" }),
    );
    h.onModel(
      () => ({
        tool: "report",
        args: { status: "needs-decision", key: "enable", text: "enable Haiku?" },
      }),
      "mate",
    );
    h.onModel(() => ({ text: "waiting for the decision" }), "mate");
    h.onModel(
      () => ({
        tool: "report",
        args: {
          status: "paused",
          text: "carrying on",
          until: new Date(Date.now() + 3_600_000).toISOString(),
        },
      }),
      "mate",
    );
    h.onModel(() => ({ text: "noted the answer" }), "mate");
    const pane = await startMain(lab, here, h, false, [
      ...mateArgs(h),
      "--fleet-url",
      cardd.url,
      "--fleet-token",
      token,
      "--fleet-role",
      "worker",
    ]);
    await until(pane, "the pending decision to block the worker", (s) => s.status === "blocked");
    await mate.waitForEntry((entry) => entry.fields["status"] === "needs-decision", "the report");
    await clear(mate, card.id);
    assert.equal(
      (await until(pane, "the cleared hold to stop blocking", (s) => s.status === "idle")).status,
      "idle",
    );
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal((await agentOf(pane)).status, "idle");
  });
}
