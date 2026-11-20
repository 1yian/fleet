import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import {
  mateConnected as connected,
  startDispatchLab,
  stopDispatchLab,
  WORKER_WAIT_MS,
  type DispatchLab,
} from "../support/dispatch-lab.ts";
import { FakeBrowser } from "../support/fake-browser.ts";
import { poll, type Move, type Turn } from "../support/harness.ts";
import { tempDir } from "../support/run-root.ts";
import { DISPATCH, scratchOf } from "../support/scratch-files.ts";

const SHELL = fileURLToPath(new URL("../support/shell-tool.ts", import.meta.url));

const BARRIER_TRIES = 600;
const CARDS = [1, 2] as const;

let parts: DispatchLab;
let browser: FakeBrowser;
let meeting: string;
beforeEach(async () => {
  browser = new FakeBrowser();
  meeting = tempDir("fleet-meeting-");
  parts = await startDispatchLab({ workerArgs: ["-e", SHELL] });
  parts.cardd.yolo("site");
});
afterEach(async () => {
  await stopDispatchLab(parts);
});

const browse = (): string => `
export PATH="${browser.bin}:$PATH" FAKE_BROWSER_ROOT="${browser.state}"
me=$(basename "$FLEET_SCRATCH")
echo "$FLEET_ATTEMPT $CHROME_DEVTOOLS_AXI_SESSION" > "$FLEET_SCRATCH/names.txt"
meet() {
  : > "${meeting}/$me.$1"
  tries=0
  while [ "$(ls "${meeting}" | grep -c "\\.$1$")" -lt 2 ]; do
    tries=$((tries + 1))
    [ "$tries" -gt ${String(BARRIER_TRIES)} ] && return 1
    sleep 0.1
  done
}
chrome-devtools-axi newpage "http://shop.test/$me" > "$FLEET_SCRATCH/opened.txt" 2>&1
meet opened
chrome-devtools-axi open "http://shop.test/$me/checkout" > "$FLEET_SCRATCH/navigated.txt" 2>&1
meet navigated
chrome-devtools-axi eval location.href > "$FLEET_SCRATCH/seen.txt" 2>&1
chrome-devtools-axi pages > "$FLEET_SCRATCH/tabs.txt" 2>&1
meet looked
tab=$(chrome-devtools-axi pages | awk -F '\\t' '$3 == "selected" { print $1 }')
chrome-devtools-axi closepage "$tab" > "$FLEET_SCRATCH/closed.txt" 2>&1
meet closed
chrome-devtools-axi pages > "$FLEET_SCRATCH/left.txt" 2>&1
meet done
`;

const browsing = (turns: Turn[]): Move =>
  turns.some((turn) => turn.role === "toolResult")
    ? { tool: "report", args: { status: "done", text: "drove the browser" } }
    : { tool: "bash", args: { command: browse() } };

const hostDir = (): string => {
  const dir = process.env["FLEET_HOST_DIR"];
  assert.ok(dir !== undefined && dir !== "", "the run has no host folder");
  return dir;
};

const evidence = (card: number, file: string): string =>
  readFileSync(join(scratchOf(hostDir()), `c-${String(card)}`, file), "utf8");

async function bothDone(): Promise<void> {
  await poll(
    () =>
      CARDS.every((card) => existsSync(join(meeting, `c-${String(card)}.done`))) ? true : undefined,
    "both cards to finish driving the browser",
    WORKER_WAIT_MS,
  );
}

test("two cards of one lane driving the host's browser at once each keep their own tab", async () => {
  const { h, mate } = parts;
  mkdirSync(meeting, { recursive: true });
  h.onModel(() => ({ tool: "board", args: {} }), "mate");
  h.onModel(() => ({ tool: "dispatch", args: DISPATCH }), "mate");
  h.onModel(
    () => ({
      tool: "dispatch",
      args: { ...DISPATCH, title: "Check the checkout", name: "check-the-checkout" },
    }),
    "mate",
  );
  h.onModel(() => ({ text: "dispatched both" }), "mate");
  for (let call = 0; call < CARDS.length * 2; call += 1) h.onModel(browsing, "worker");
  await connected(h);
  mate.prompt("run both checks");
  await bothDone();

  for (const card of CARDS) {
    const attempt = `c-${String(card)}-a1`;
    const own = `http://shop.test/c-${String(card)}/checkout`;
    assert.equal(
      evidence(card, "seen.txt").trim(),
      own,
      `the page that c-${String(card)} acted on`,
    );
    assert.deepEqual(
      evidence(card, "tabs.txt")
        .trim()
        .split("\n")
        .map((row) => row.split("\t")[1]),
      [own],
      `the tabs that c-${String(card)} could see`,
    );
    assert.equal(evidence(card, "left.txt").trim(), "", `the tabs left for c-${String(card)}`);
    assert.equal(
      evidence(card, "names.txt").trim(),
      `${attempt} ${attempt}`,
      `the attempt name and browser session that c-${String(card)} was started with`,
    );
  }
});
