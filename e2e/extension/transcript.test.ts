import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { Cardd, type Session } from "../support/cardd.ts";
import { gate, Harness } from "../support/harness.ts";
import { HerdrLab } from "../support/herdr.ts";
import { records } from "../support/json.ts";
import { configureMain, Scratch, startMain } from "../support/scratch.ts";

const WAIT_MS = 60_000;
const BIN = fileURLToPath(new URL("../../node_modules/.bin", import.meta.url));
const EVIDENCE = process.env["TRANSCRIPT_EVIDENCE_DIR"];

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

async function matePane(): Promise<{ group: number; shell: number }> {
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
    group: Number(info[0]?.["foreground_process_group_id"]),
    shell: Number(info[0]?.["shell_pid"]),
  };
}

async function screenWhere(pane: string, what: string, ready: (screen: string) => boolean) {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const screen = await lab.screen(pane);
    if (ready(screen)) return screen;
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}:\n${screen}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

function keep(name: string, screen: string, colored: string): void {
  if (EVIDENCE === undefined) return;
  mkdirSync(EVIDENCE, { recursive: true });
  writeFileSync(join(EVIDENCE, `${name}.txt`), screen);
  writeFileSync(join(EVIDENCE, `${name}.ansi`), colored);
}

const NARROW = 61;

async function resize(pane: string, cols: number): Promise<void> {
  const info = await lab.run(["pane", "process-info", "--pane", pane]);
  const shell = records([info["process_info"]])[0]?.["shell_pid"];
  const tty = execFileSync("ps", ["-o", "tty=", "-p", String(shell)], { encoding: "utf8" }).trim();
  const flag = process.platform === "darwin" ? "-f" : "-F";
  execFileSync("stty", [flag, `/dev/${tty}`, "cols", String(cols)]);
}

const RULE = /^── ([a-z0-9-]+) ─+$/;
const ESC = String.fromCharCode(27);
const SGR = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
const mutedRule = (line: string): boolean =>
  line.startsWith(`${ESC}[`) && RULE.test(line.replace(SGR, "").trimEnd());

interface Transcript {
  readonly shown: string[];
  readonly width: number;
  readonly rules: string[];
  readonly gaps: boolean;
}

function transcript(screen: string): Transcript {
  const lines = screen.split("\n").map((line) => line.trimEnd());
  const editor = lines.findIndex((line) => /^─+$/.test(line));
  const width = lines[editor]?.length ?? 0;
  const start = lines.findIndex((line) => line.startsWith("[Extensions]"));
  const body = lines
    .slice(start + 1, editor)
    .filter((line) => !line.trim().startsWith("Warning:") && !line.startsWith("  fake-model"));
  const rules = body.filter((line) => RULE.test(line));
  return {
    width,
    rules,
    gaps: body.every((line, index) => !RULE.test(line) || index === 0 || body[index - 1] === ""),
    shown: body
      .filter((line) => line.trim() !== "" && !line.includes("Working"))
      .map((line) => (RULE.test(line) ? `── ${RULE.exec(line)?.[1] ?? ""} ──` : line.trim())),
  };
}

const CAPTAIN = "What is on the board?";
const FIRST = "The board is quiet.\n\nNothing waits on you.";
const SECOND = "Cleo is idle.";
const THINKING = "Weighing the board.";
const THANKS = "Thanks.";
const RULING = "Cleo wants a ruling on the scrollbar.";

const answered = [
  "── captain ──",
  CAPTAIN,
  "── 1stmate ──",
  THINKING,
  "The board is quiet.",
  "Nothing waits on you.",
  SECOND,
  "── captain ──",
  THANKS,
];

test("each message gets one muted rule and a sender label, through streaming, a silent yield, a resize, and a restart", async () => {
  const thinking = gate();
  h.onModel(async () => {
    await thinking.wait;
    return { thinking: THINKING, texts: [FIRST, SECOND] };
  }, "mate");
  h.onModel(() => ({ text: "" }), "mate");
  const pane = await startMain(lab, scratch, h);
  await screenWhere(pane, "the mate to start", (screen) => screen.includes("[Extensions]"));

  await lab.submit(pane, CAPTAIN);
  const waiting = await screenWhere(
    pane,
    "the mate to start working",
    (screen) => screen.includes(CAPTAIN) && screen.includes("Working"),
  );
  keep("1-streaming", waiting, await lab.coloredScreen(pane));
  assert.deepEqual(transcript(waiting).shown, ["── captain ──", CAPTAIN]);

  thinking.open();
  const replied = await screenWhere(pane, "the reply", (screen) => screen.includes(SECOND));
  const colored = await lab.coloredScreen(pane);
  keep("2-reply", replied, colored);
  const first = transcript(replied);
  assert.deepEqual(first.shown, answered.slice(0, 7));
  assert.ok(
    first.rules.every((rule) => rule.length === first.width),
    "a rule fills the width",
  );
  assert.ok(first.gaps, "a blank line precedes every rule");
  assert.ok(colored.split("\n").some(mutedRule), "a rule is drawn in one muted color");

  await lab.submit(pane, THANKS);
  await h.waitForCall(1, "mate", WAIT_MS);
  const yielded = await screenWhere(pane, "the silent yield", (screen) => screen.includes(THANKS));
  keep("3-silent-yield", yielded, await lab.coloredScreen(pane));
  assert.deepEqual(transcript(yielded).shown, answered);

  await resize(pane, NARROW);
  const narrow = await screenWhere(pane, "the narrow pane", (screen) => {
    const now = transcript(screen);
    return now.width === NARROW && now.shown.length >= answered.length;
  });
  keep("4-narrow", narrow, await lab.coloredScreen(pane));
  const squeezed = transcript(narrow);
  assert.ok(squeezed.rules.every((rule) => rule.length === NARROW));
  assert.ok(squeezed.gaps);
  assert.deepEqual(
    squeezed.rules.map((rule) => RULE.exec(rule)?.[1]),
    ["captain", "1stmate", "captain"],
  );
});

test("a restarted mate and a fleet row keep the same rules and labels", async () => {
  h.onModel(() => ({ text: "Cleo is idle." }), "mate");
  h.onModel(() => ({ text: RULING }), "mate");
  const pane = await startMain(lab, scratch, h);
  await screenWhere(pane, "the mate to start", (screen) => screen.includes("[Extensions]"));
  await lab.submit(pane, CAPTAIN);
  await screenWhere(pane, "the first reply", (screen) => screen.includes(SECOND));
  const card: unknown = await cleo.call("card.new", { title: "Fix the scrollbar", kind: "scout" });
  const id: unknown = Reflect.get(Object(card), "id");
  await cleo.call("hold", {
    card: id,
    question: "Fix the scrollbar?",
    options: ["Yes"],
  });
  const live = await screenWhere(pane, "the fleet row and its reply", (screen) =>
    screen.includes(RULING),
  );
  const expected = [
    "── captain ──",
    CAPTAIN,
    "── 1stmate ──",
    SECOND,
    "── fleet ──",
    "[fleet] cleo on c-2 fix-the-scrollbar (hold): Fix the scrollbar?",
    "── 1stmate ──",
    RULING,
  ];
  keep("5-fleet-row", live, await lab.coloredScreen(pane));
  assert.deepEqual(transcript(live).shown, expected);

  const { group, shell } = await matePane();
  process.kill(-group, "SIGKILL");
  const deadline = Date.now() + 30_000;
  while ((await matePane()).group !== shell) {
    assert.ok(Date.now() < deadline, "the mate's pane did not return to its shell");
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  await startMain(lab, scratch, h, true);
  const restored = await screenWhere(pane, "the restored conversation", (screen) =>
    screen.includes(RULING),
  );
  keep("6-restored", restored, await lab.coloredScreen(pane));
  assert.deepEqual(transcript(restored).shown, expected);
});
