import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { CardSchema, CardViewSchema, check, HttpOutcomeSchema, type Entry } from "@fleet/protocol";
import { Cardd } from "../support/cardd.ts";
import { Harness, type Turn } from "../support/harness.ts";
import { HerdrLab } from "../support/herdr.ts";
import { records } from "../support/json.ts";
import { configureMain, mateArgs, Scratch, startMain } from "../support/scratch.ts";

const WAIT_MS = 60_000;
const BIN = fileURLToPath(new URL("../../node_modules/.bin", import.meta.url));
const STALE = "Cannot find module '/old/pi/dist/index.js' imported from /app/pi/loader.js";
const MARK = "review the open scrollbar cards";

let mainToken: string;
let cardd: Cardd;
let h: Harness;
let lab: HerdrLab;
let here: Scratch;
beforeEach(async () => {
  cardd = await Cardd.start({ CARDD_TIMING_SCALE: "0.02" });
  h = await Harness.start();
  here = new Scratch();
  mainToken = cardd.addLane("main", undefined, here.root);
  configureMain(here, cardd.url, mainToken);
  here.addLane("ops", {
    url: cardd.url,
    token: cardd.addLane("ops", "main"),
    args: mateArgs(h),
  });
  lab = await HerdrLab.start({
    ...h.piEnv("mate"),
    PATH: `${BIN}:${process.env["PATH"] ?? ""}`,
    FLEET_SUPERVISE_MS: "1000",
  });
});
afterEach(async (t) => {
  await lab.printIfFailed(t);
  const stopped = await Promise.allSettled([lab.stop(), h.stop(), cardd.stop()]);
  here.dispose();
  const failed = stopped.find((result) => result.status === "rejected");
  if (failed !== undefined) throw new Error(`cleanup failed: ${String(failed.reason)}`);
});

const lastUser = (turns: Turn[]): string =>
  turns.findLast((turn) => turn.role === "user")?.text ?? "";
const isOps = (turns: Turn[]): boolean =>
  turns.some((turn) => turn.role === "user" && turn.text.includes(MARK));

async function entriesOf(card: number): Promise<Entry[]> {
  const sent = await cardd.post(mainToken, "card", { card });
  const outcome = check(HttpOutcomeSchema, sent.body);
  if (!outcome.ok) throw new Error(outcome.error);
  return check(CardViewSchema, outcome.value).entries;
}

async function cardNames(): Promise<string> {
  return JSON.stringify((await cardd.board()).cards.map((each) => [each.id, each.name]));
}

async function groupOf(lane: string): Promise<number> {
  const workspaces = records((await lab.run(["workspace", "list"]))["workspaces"]);
  const workspace = workspaces.find((each) => each["label"] === `2ndmate-${lane}`);
  const listed = await lab.run([
    "pane",
    "list",
    "--workspace",
    String(workspace?.["workspace_id"]),
  ]);
  const pane = String(records(listed["panes"])[0]?.["pane_id"]);
  const info = records([(await lab.run(["pane", "process-info", "--pane", pane]))["process_info"]]);
  return Number(info[0]?.["foreground_process_group_id"]);
}

async function until<T>(read: () => Promise<T | undefined>, what: string): Promise<T> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const value = await read().catch(() => undefined);
    if (value !== undefined) return value;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

test("a second mate with a stale module is replaced on its own session, lane card and work, and verified by a real answer and action", async () => {
  const tree = `${here.root}.worktrees/lane-ops`;
  let failed = false;
  let before: number | undefined;
  let cardsBefore = "";
  const opsTurn = (
    turns: Turn[],
  ):
    | { fail: string }
    | { text: string }
    | { tool: string; args: Record<string, string | number> } => {
    if (lastUser(turns).includes("recovery check"))
      return turns.at(-1)?.role === "toolResult"
        ? { text: "recovered" }
        : { tool: "board", args: {} };
    if (failed) return { text: "took the task" };
    failed = true;
    return { fail: STALE };
  };
  const mainTurn = async (
    turns: Turn[],
  ): Promise<{ text: string } | { tool: string; args: Record<string, string | number> }> => {
    const user = lastUser(turns);
    if (turns.at(-1)?.role === "toolResult") return { text: "noted" };
    if (!user.includes("runtime failure")) {
      writeFileSync(join(tree, "dirty.txt"), "uncommitted work\n");
      return { tool: "comment", args: { lane: "ops", text: MARK } };
    }
    const found = /Incident (\d+), process generation (\d+)/.exec(user);
    before = await groupOf("ops");
    cardsBefore = await cardNames();
    return {
      tool: "restart_card",
      args: {
        card: Number(/c-(\d+)/.exec(user)?.[1]),
        incident: Number(found?.[1]),
        generation: Number(found?.[2]),
        mode: "replace",
      },
    };
  };
  for (let call = 0; call < 24; call += 1)
    h.onModel((turns) => (isOps(turns) ? opsTurn(turns) : mainTurn(turns)), "mate");
  await startMain(lab, here, h);
  await until(() => Promise.resolve(existsSync(tree) ? true : undefined), "the ops home");
  const ghost = await cardd.connect(cardd.addLane("ghost", "main"));
  const wake = check(
    CardSchema,
    await ghost.call("card.new", { title: "Wake main", kind: "scout" }),
  );
  await ghost.call("hold", {
    card: wake.id,
    question: "ok?",
    options: ["Yes"],
  });

  const laneCard = await until(async () => {
    const card = (await cardd.board()).cards.find((each) => each.name === "ops");
    return card;
  }, "the ops lane card");
  const entries = await until(async () => {
    const view = await entriesOf(laneCard.id);
    return view.some((entry) => entry.body.includes("recovered (replace)")) ? view : undefined;
  }, "the verified recovery");
  await ghost.close();

  const failure = entries.find((entry) => entry.fields["condition"] === "runtime-failure");
  assert.match(failure?.body ?? "", /^runtime failure: ops its model turn failed/);
  assert.match(failure?.body ?? "", /Classified stale-module\./);
  const after = await groupOf("ops");
  assert.ok(
    before !== undefined && after !== before,
    `process ${String(before)} -> ${String(after)}`,
  );
  assert.equal(await cardNames(), cardsBefore);
  assert.equal(readFileSync(join(tree, "dirty.txt"), "utf8"), "uncommitted work\n");
  const resumed =
    h
      .callsOf("mate")
      .findLast((turns) => isOps(turns) && lastUser(turns).includes("recovery check")) ?? [];
  assert.ok(
    resumed.some((turn) => turn.text.includes(MARK)),
    "the old conversation is gone",
  );
  assert.match(
    lastUser(resumed),
    /recovery check 1 from main: this is a health check, not new work/,
  );
  assert.equal(entries.filter((entry) => entry.body.includes("recovered (replace)")).length, 1);
});
