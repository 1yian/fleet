// /calm in a real mate (docs/calm.md). `fleet up` starts the mate's Pi in a herdr pane,
// with the scripted model. The test reads what the pane shows before and after /calm.
// It writes each screen to CALM_EVIDENCE_DIR when that is set.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { Cardd, type Session } from "../support/cardd.ts";
import { gate, Harness } from "../support/harness.ts";
import { HerdrLab } from "../support/herdr.ts";
import { records } from "../support/json.ts";

const WAIT_MS = 60_000;
const LAUNCH = fileURLToPath(new URL("../../packages/extension/src/launch.ts", import.meta.url));
const BIN = fileURLToPath(new URL("../../node_modules/.bin", import.meta.url));
const EVIDENCE = process.env["CALM_EVIDENCE_DIR"];

let cardd: Cardd;
let h: Harness;
let lab: HerdrLab;
let home: string;
let config: string;
let cleo: Session;
beforeEach(async () => {
  cardd = await Cardd.start();
  h = await Harness.start();
  home = mkdtempSync(join(tmpdir(), "fleet-home-"));
  const token = cardd.addLane("main", undefined, home);
  cleo = await cardd.connect(cardd.addLane("cleo", "main"));
  config = mkdtempSync(join(tmpdir(), "fleet-config-"));
  writeFileSync(
    join(config, "main.json"),
    JSON.stringify({ url: cardd.url, token, home, args: h.piArgs() }),
  );
  lab = await HerdrLab.start({ ...h.piEnv("mate"), PATH: `${BIN}:${process.env["PATH"] ?? ""}` });
});
afterEach(async () => {
  const stopped = await Promise.allSettled([cleo.close(), lab.stop(), h.stop(), cardd.stop()]);
  const failed = stopped.find((result) => result.status === "rejected");
  if (failed !== undefined) throw new Error(`cleanup failed: ${String(failed.reason)}`);
});

const up = (): string =>
  execFileSync("node", [LAUNCH, "up"], {
    encoding: "utf8",
    env: { ...process.env, FLEET_CONFIG_DIR: config, HERDR_SESSION: lab.name },
  });

async function matePane(): Promise<{ pane: string; group: number; shell: number }> {
  const workspaces = records((await lab.run(["workspace", "list"]))["workspaces"]);
  const workspace = workspaces.find((each) => each["label"] === "fleet-main");
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

/** Waits until the pane's screen satisfies `ready`, and returns that screen. */
async function screenWhere(pane: string, what: string, ready: (s: string) => boolean) {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const screen = await lab.screen(pane);
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
  await cleo.call("ask", {
    card: id,
    question: `${title}?`,
    options: ["Yes"],
  });
}

const FLEET_ROW = "[fleet] cleo on c-1 (ask)";
const TOOL_ROW = "board";
const NOTE = "Checking the board first.";
const REPLY = "Cleo wants a decision on the scrollbar fix.";
const CAPTAIN = "Any news for me?";
const ANSWER = "Nothing else is waiting.";

test("/calm hides fleet rows, tool rows, and working notes, keeps the conversation, and survives a restart", async () => {
  h.onModel(() => ({ tool: "board", text: NOTE }), "mate");
  h.onModel(() => ({ text: REPLY }), "mate");
  const working = gate();
  h.onModel(async () => {
    await working.wait;
    return { text: ANSWER };
  }, "mate");
  assert.equal(up(), "main: started in fleet-main\n");
  const { pane } = await matePane();
  await cleoAsks("Ship the scrollbar fix");

  // Calm is off until the first /calm: every row shows.
  const before = await screenWhere(pane, "the first turn", (s) => s.includes(REPLY));
  keep("1-before-calm", before);
  for (const shown of [FLEET_ROW, TOOL_ROW, NOTE, REPLY]) assert.ok(before.includes(shown), shown);

  await lab.submit(pane, "/calm");
  const after = await screenWhere(pane, "calm to hide the rows", (s) => !s.includes(FLEET_ROW));
  keep("2-after-calm", after);
  assert.ok(after.includes(REPLY), "the mate's reply stays");
  assert.ok(!after.includes(NOTE), "the short note before the tool call hides");
  assert.ok(!after.includes("board"), "the tool row hides");
  assert.equal(readFileSync(join(home, "config", "calm"), "utf8"), "on\n");

  // The captain's prompt and the answer stay; a new fleet message stays out of sight.
  await lab.submit(pane, CAPTAIN);
  // While the mate works, the boat replaces Pi's own working row.
  const sailing = await screenWhere(pane, "the boat", (s) => s.includes("◿│◣"));
  keep("3-calm-working-boat", sailing);
  assert.ok(!sailing.includes("Working"));
  working.open();
  await screenWhere(pane, "the answer", (s) => s.includes(ANSWER));
  await cleoAsks("Drop the old banner");
  const turns = await h.waitForCall(3, "mate", WAIT_MS);
  const live = await screenWhere(pane, "the second turn", (s) => s.includes(ANSWER));
  keep("4-calm-conversation", live);
  assert.ok(live.includes(CAPTAIN) && live.includes(ANSWER));
  assert.ok(!live.includes("[fleet]"));
  // Nothing was dropped from the model's context.
  const context = turns.map((turn) => `${turn.role}: ${turn.text}`).join("\n");
  assert.ok(
    context.includes(FLEET_ROW) && context.includes("toolResult:") && context.includes(NOTE),
  );

  // The choice is saved per home: a restarted mate comes back calm.
  const { group, shell } = await matePane();
  process.kill(-group, "SIGKILL");
  const deadline = Date.now() + 30_000;
  while ((await matePane()).group !== shell) {
    assert.ok(Date.now() < deadline, "the mate's pane did not return to its shell");
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.equal(up(), "main: started in fleet-main\n");
  // Until the new Pi takes the screen, it still shows the shell and the command that starts it.
  const restarted = await screenWhere(
    pane,
    "the restored conversation",
    (s) => s.includes(CAPTAIN) && !s.includes("FLEET_CONFIG_DIR"),
  );
  keep("5-after-restart", restarted);
  assert.ok(restarted.includes(ANSWER) && !restarted.includes("[fleet]"));

  // /calm again turns it off and every row comes back.
  await lab.submit(pane, "/calm");
  const off = await screenWhere(pane, "the rows to return", (s) => s.includes(FLEET_ROW));
  keep("6-calm-off", off);
  assert.ok(off.includes(NOTE) && off.includes(TOOL_ROW));
  assert.equal(readFileSync(join(home, "config", "calm"), "utf8"), "off\n");
});
