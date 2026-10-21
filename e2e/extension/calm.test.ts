import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { Cardd, type Session } from "../support/cardd.ts";
import { gate, Harness } from "../support/harness.ts";
import { HerdrLab } from "../support/herdr.ts";
import { records } from "../support/json.ts";
import { configureMain, mateArgs, Scratch, startMain } from "../support/scratch.ts";

const WAIT_MS = 60_000;
const LABEL_RESETTER = fileURLToPath(new URL("../support/thinking-label.ts", import.meta.url));
const BIN = fileURLToPath(new URL("../../node_modules/.bin", import.meta.url));
const EVIDENCE = process.env["CALM_EVIDENCE_DIR"];

let cardd: Cardd;
let h: Harness;
let lab: HerdrLab;
let scratch: Scratch;
let cleo: Session;
beforeEach(async () => {
  cardd = await Cardd.start();
  h = await Harness.start();
  scratch = new Scratch();
  configureMain(scratch, cardd.url, cardd.addLane("main", undefined, scratch.root));
  cleo = await cardd.connect(cardd.addLane("cleo", "main"));
  lab = await HerdrLab.start({ ...h.piEnv("mate"), PATH: `${BIN}:${process.env["PATH"] ?? ""}` });
});
afterEach(async (t) => {
  await lab.printIfFailed(t);
  const stopped = await Promise.allSettled([cleo.close(), lab.stop(), h.stop(), cardd.stop()]);
  scratch.dispose();
  const failed = stopped.find((result) => result.status === "rejected");
  if (failed !== undefined) throw new Error(`cleanup failed: ${String(failed.reason)}`);
});

async function matePane(): Promise<{ pane: string; group: number; shell: number }> {
  const workspaces = records((await lab.run(["workspace", "list"]))["workspaces"]);
  const workspace = workspaces.find((each) => each["label"] === "1stmate");
  const listed = await lab.run([
    "pane",
    "list",
    "--workspace",
    String(workspace?.["workspace_id"]),
  ]);
  const pane = String(records(listed["panes"])[0]?.["pane_id"]);
  const info = records([(await lab.run(["pane", "process-info", "--pane", pane]))["process_info"]]);
  return {
    pane,
    group: Number(info[0]?.["foreground_process_group_id"]),
    shell: Number(info[0]?.["shell_pid"]),
  };
}

async function screenWhere(
  pane: string,
  what: string,
  ready: (s: string) => boolean,
  scrollback = false,
) {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const screen = scrollback ? await lab.history(pane) : await lab.screen(pane);
    if (ready(screen)) return screen;
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}:\n${screen}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

function keep(name: string, screen: string): void {
  if (EVIDENCE === undefined) return;
  mkdirSync(EVIDENCE, { recursive: true });
  writeFileSync(join(EVIDENCE, `${name}.txt`), screen);
}

async function cleoAsks(title: string): Promise<void> {
  const card: unknown = await cleo.call("card.new", { title, kind: "scout" });
  const id: unknown = Reflect.get(Object(card), "id");
  await cleo.call("hold", {
    card: id,
    question: `${title}?`,
    options: ["Yes"],
  });
}

const FLEET_ROW = "[fleet] cleo on c-2 ship-the-scrollbar-fix (hold)";
const TOOL_ROW = "board";
const NOTE = "Checking the board first.";
const REPLY = "Cleo wants a decision on the scrollbar fix.";
const CAPTAIN = "Any news for me?";
const ANSWER = "Nothing else is waiting.";
const BANNER_REPLY = "The banner can go.";
const showing =
  (shown: readonly string[], hidden: readonly string[] = []) =>
  (screen: string): boolean =>
    shown.every((text) => screen.includes(text)) && !hidden.some((text) => screen.includes(text));

test("/calm hides fleet rows, tool rows, and working notes, keeps the conversation, and survives a restart", async () => {
  h.onModel(() => ({ tool: "board", text: NOTE }), "mate");
  h.onModel(() => ({ text: REPLY }), "mate");
  const working = gate();
  h.onModel(async () => {
    await working.wait;
    return { text: ANSWER };
  }, "mate");
  h.onModel(() => ({ text: BANNER_REPLY }), "mate");
  const pane = await startMain(lab, scratch, h);
  await cleoAsks("Ship the scrollbar fix");

  const before = await screenWhere(
    pane,
    "every row of the first turn",
    showing([FLEET_ROW, TOOL_ROW, NOTE, REPLY]),
  );
  keep("1-before-calm", before);

  await lab.submit(pane, "/calm");
  const after = await screenWhere(
    pane,
    "calm to hide the rows",
    showing([REPLY], [FLEET_ROW, NOTE, TOOL_ROW]),
  );
  keep("2-after-calm", after);
  assert.equal(readFileSync(join(scratch.root, "config", "calm"), "utf8"), "on\n");

  await lab.submit(pane, CAPTAIN);
  const sailing = await screenWhere(pane, "the boat", showing(["◿│◣"], ["Working"]));
  keep("3-calm-working-boat", sailing);
  working.open();
  await screenWhere(pane, "the answer", showing([ANSWER]));
  await cleoAsks("Drop the old banner");
  const turns = await h.waitForCall(3, "mate", WAIT_MS);
  const live = await screenWhere(
    pane,
    "the second turn, without its fleet row",
    showing([CAPTAIN, ANSWER, BANNER_REPLY], ["[fleet]"]),
  );
  keep("4-calm-conversation", live);
  const context = turns.map((turn) => `${turn.role}: ${turn.text}`).join("\n");
  assert.ok(
    context.includes(FLEET_ROW) && context.includes("toolResult:") && context.includes(NOTE),
  );

  const { group, shell } = await matePane();
  process.kill(-group, "SIGKILL");
  const deadline = Date.now() + 30_000;
  while ((await matePane()).group !== shell) {
    assert.ok(Date.now() < deadline, "the mate's pane did not return to its shell");
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  await startMain(lab, scratch, h, true);
  await h.waitForNth((e) => e["type"] === "fleet_connected", 2, "the restarted mate to connect");
  const restarted = await screenWhere(
    pane,
    "the restored conversation, still calm",
    showing([CAPTAIN, ANSWER, BANNER_REPLY], ["[fleet]"]),
  );
  keep("5-after-restart", restarted);

  await lab.submit(pane, "/calm");
  const off = await screenWhere(
    pane,
    "the rows to return",
    showing([FLEET_ROW, NOTE, TOOL_ROW]),
    true,
  );
  keep("6-calm-off", off);
  assert.equal(readFileSync(join(scratch.root, "config", "calm"), "utf8"), "off\n");
});

const THINKING_LABEL = "Thinking...";
const WEIGHING = "Weighing whether Cleo needs a ruling.";
const CHECKING = "Checking the board before answering.";
const SETTLED = "Nothing needs you.";
const NEXT = "Still nothing.";

test("calm shows no Thinking... label for hidden thinking, in a live turn with a tool call, after another extension resets the label, after /calm toggles, and after a restart", async () => {
  mkdirSync(join(h.dir, "agent"), { recursive: true });
  writeFileSync(join(h.dir, "agent", "settings.json"), JSON.stringify({ hideThinkingBlock: true }));
  mkdirSync(join(scratch.root, "config"), { recursive: true });
  writeFileSync(join(scratch.root, "config", "calm"), "on\n");
  const working = gate();
  h.onModel(async () => {
    await working.wait;
    return { thinking: CHECKING, tool: "board" };
  }, "mate");
  h.onModel(() => ({ thinking: WEIGHING, text: SETTLED }), "mate");
  h.onModel(() => ({ thinking: WEIGHING, text: NEXT }), "mate");
  const args = [...mateArgs(h), "-e", LABEL_RESETTER];
  const pane = await startMain(lab, scratch, h, false, args);
  await screenWhere(pane, "the mate to start", showing(["[Extensions]"]));

  await lab.submit(pane, CAPTAIN);
  const pending = await screenWhere(pane, "the boat", showing(["◿│◣"]));
  keep("7-thinking-pending", pending);
  assert.ok(!pending.includes(THINKING_LABEL));
  working.open();
  const live = await screenWhere(
    pane,
    "the answer",
    showing([SETTLED], [THINKING_LABEL, WEIGHING]),
  );
  keep("8-calm-thinking-hidden", live);

  await lab.submit(pane, "/calm");
  const normal = await screenWhere(
    pane,
    "the label to return",
    showing([THINKING_LABEL, SETTLED]),
    true,
  );
  keep("9-normal-thinking-label", normal);

  await lab.submit(pane, "/calm");
  const again = await screenWhere(
    pane,
    "the label to go away",
    showing([SETTLED], [THINKING_LABEL]),
  );
  keep("10-calm-again", again);

  await lab.submit(pane, CAPTAIN);
  const next = await screenWhere(pane, "the next answer", showing([NEXT]));
  assert.ok(!next.includes(THINKING_LABEL));
  keep("11-calm-next-turn", next);

  const { group, shell } = await matePane();
  process.kill(-group, "SIGKILL");
  const deadline = Date.now() + 30_000;
  while ((await matePane()).group !== shell) {
    assert.ok(Date.now() < deadline, "the mate's pane did not return to its shell");
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  await startMain(lab, scratch, h, true, args);
  await h.waitForNth((e) => e["type"] === "fleet_connected", 2, "the restarted mate to connect");
  const restarted = await screenWhere(
    pane,
    "the restored conversation, still calm",
    showing([NEXT], [THINKING_LABEL]),
  );
  keep("12-calm-thinking-restart", restarted);
});
