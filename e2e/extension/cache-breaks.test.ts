import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { Cardd } from "../support/cardd.ts";
import { Harness } from "../support/harness.ts";
import { HerdrLab } from "../support/herdr.ts";
import { isRecord, optionalString, parseRecord } from "../support/json.ts";
import { configureMain, Scratch, settingsArgs, startMain } from "../support/scratch.ts";

const WAIT_MS = 60_000;
const BIN = fileURLToPath(new URL("../../node_modules/.bin", import.meta.url));
const SUPPORT = new URL("../support/", import.meta.url);
const FAKE_MODEL = fileURLToPath(new URL("fake-model.ts", SUPPORT));
const FAKE_ANTHROPIC = fileURLToPath(new URL("fake-anthropic.ts", SUPPORT));
const FAKE_CACHE_LIFETIME_MS = 12_000;
const CACHED = 50_000;
const SECRET_SYSTEM_TEXT = "Prefer the blue palette in every answer.";

let cardd: Cardd;
let h: Harness;
let lab: HerdrLab;
let scratch: Scratch;
beforeEach(async () => {
  cardd = await Cardd.start();
  h = await Harness.start();
  scratch = new Scratch();
  const mainToken = cardd.addLane("main", undefined, scratch.root);
  mkdirSync(join(h.dir, "agent"), { recursive: true });
  writeFileSync(
    join(h.dir, "agent", "settings.json"),
    JSON.stringify({ defaultProvider: "tier", defaultModel: "auto" }),
  );
  lab = await HerdrLab.start({ ...h.piEnv("mate"), PATH: `${BIN}:${process.env["PATH"] ?? ""}` });
  configureMain(scratch, cardd.url, mainToken);
});
afterEach(async (t) => {
  await lab.printIfFailed(t);
  const stopped = await Promise.allSettled([lab.stop(), h.stop(), cardd.stop()]);
  scratch.dispose();
  const failed = stopped.find((result) => result.status === "rejected");
  if (failed !== undefined) throw new Error(`cleanup failed: ${String(failed.reason)}`);
});

function wireArgs(): string[] {
  const args = settingsArgs(h);
  const at = args.indexOf(FAKE_MODEL);
  return [...args.slice(0, at - 1), ...args.slice(at + 1), "-e", FAKE_ANTHROPIC];
}

function recordedBreaks(file: string): Record<string, unknown>[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map(parseRecord)
    .filter((entry) => entry["customType"] === "fleet-cache-break")
    .map((entry) => (isRecord(entry["data"]) ? entry["data"] : {}));
}

test("main records why its prompt cache broke and shows whether its cache is warm or cold in its status line", async () => {
  const cacheHit = { text: "ok", cacheRead: CACHED, cacheWrite: 10 };
  const cacheMiss = { text: "ok", cacheRead: 0, cacheWrite: CACHED };
  for (const move of [cacheMiss, cacheHit, cacheMiss, cacheHit, cacheMiss, cacheMiss, cacheMiss])
    h.onModel(() => move, "mate");
  const pane = await startMain(lab, scratch, h, false, wireArgs());
  const session = await h.waitFor((event) => event["type"] === "session", "the session file");
  const file = optionalString(session, "file") ?? "";
  await h.waitFor((event) => event["type"] === "fleet_connected", "the mate to join the fleet");

  let turns = 0;
  const ask = async (): Promise<void> => {
    turns += 1;
    h.send(turns, "followUp", `Turn ${String(turns)}`);
    await h.waitForNth((event) => event["type"] === "settled", turns, `turn ${String(turns)}`);
  };
  const status = async (text: string): Promise<void> => {
    const deadline = Date.now() + WAIT_MS;
    while (!(await lab.screen(pane)).includes(text)) {
      if (Date.now() > deadline) assert.fail(`no "${text}" on\n${await lab.screen(pane)}`);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  };

  assert.ok(!(await lab.screen(pane)).includes("cache "), "no cache state before a request");
  await ask();
  await status("cache warm");
  await status("cache cold <1m");
  await ask();
  assert.deepEqual(recordedBreaks(file), [], "a warm cache read is not a break");
  await status("cache warm");
  assert.ok(!(await lab.screen(pane)).includes("cache breaks"), "no count in the line");

  h.command({ type: "add_tool", name: "extra_tool" });
  await ask();
  await status("cache warm");
  await status("broke <1m tools");
  await ask();
  await status("cache warm");
  await status("broke <1m tools");
  assert.ok(!(await lab.screen(pane)).includes("cache breaks"), "no count in the line");

  h.command({ type: "model", id: "quick" });
  await h.waitFor((event) => event["type"] === "model_set", "the model switch");
  await ask();
  await status("cache warm");
  await status("broke <1m model");
  assert.ok(!(await lab.screen(pane)).includes("cache breaks"), "no count in the line");

  h.command({ type: "system", text: SECRET_SYSTEM_TEXT });
  await ask();
  await status("cache warm");
  await status("broke <1m prompt");
  assert.ok(!(await lab.screen(pane)).includes("cache breaks"), "no count in the line");

  await new Promise((resolve) => setTimeout(resolve, FAKE_CACHE_LIFETIME_MS + 1_000));
  await ask();
  await status("cache warm");
  await status("broke <1m idle");
  assert.ok(!(await lab.screen(pane)).includes("cache breaks"), "no count in the line");

  const breaks = recordedBreaks(file);
  assert.deepEqual(
    breaks.map((each) => each["cause"]),
    ["tools", "model", "system-prompt", "idle"],
  );
  assert.deepEqual(
    breaks.map((each) => each["count"]),
    [1, 2, 3, 4],
  );
  assert.deepEqual(
    breaks.map((each) => [each["previousCached"], each["cacheRead"]]),
    [
      [CACHED + 10, 0],
      [CACHED, 0],
      [CACHED, 0],
      [CACHED, 0],
    ],
  );
  const hashes = breaks.map((each) => each["systemHash"]);
  assert.notEqual(hashes[2], hashes[1]);
  assert.equal(hashes[3], hashes[2]);
  assert.ok(
    !JSON.stringify(breaks).includes(SECRET_SYSTEM_TEXT),
    "the log holds hashes, not prompt text",
  );
});
