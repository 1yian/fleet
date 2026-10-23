import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { Cardd, type Session } from "../support/cardd.ts";
import { Harness, type Turn } from "../support/harness.ts";
import { HerdrLab } from "../support/herdr.ts";
import { configureMain, Scratch, settingsArgs, startMain } from "../support/scratch.ts";
import { tempDir } from "../support/run-root.ts";

const WAIT_MS = 60_000;
const BIN = fileURLToPath(new URL("../../node_modules/.bin", import.meta.url));
const SUPPORT = new URL("../support/", import.meta.url);
const FAKE_MODEL = fileURLToPath(new URL("fake-model.ts", SUPPORT));
const FAKE_ANTHROPIC = fileURLToPath(new URL("fake-anthropic.ts", SUPPORT));
const VIEW_LINE = /^\d+\+\d+\|/m;

let cardd: Cardd;
let h: Harness;
let lab: HerdrLab;
let scratch: Scratch;
let cleo: Session;
let memoryHome: string;
beforeEach(async () => {
  cardd = await Cardd.start();
  h = await Harness.start();
  scratch = new Scratch("fleet");
  const mainToken = cardd.addLane("main", undefined, scratch.root);
  configureMain(scratch, cardd.url, mainToken);
  cleo = await cardd.connect(cardd.addLane("cleo", "main"));
  memoryHome = tempDir("fleet-memory-");
  mkdirSync(join(h.dir, "agent"), { recursive: true });
  writeFileSync(
    join(h.dir, "agent", "settings.json"),
    JSON.stringify({ defaultProvider: "tier", defaultModel: "routed" }),
  );
  lab = await HerdrLab.start({ ...h.piEnv("mate"), PATH: `${BIN}:${process.env["PATH"] ?? ""}` });
});
afterEach(async (t) => {
  await lab.printIfFailed(t);
  const stopped = await Promise.allSettled([cleo.close(), lab.stop(), h.stop(), cardd.stop()]);
  scratch.dispose();
  rmSync(memoryHome, { recursive: true, force: true });
  const failed = stopped.find((result) => result.status === "rejected");
  if (failed !== undefined) throw new Error(`cleanup failed: ${String(failed.reason)}`);
});

function installMemory(profileConfig: Record<string, unknown>, settings: Record<string, unknown>) {
  const profile = join(memoryHome, "profiles", "main");
  mkdirSync(profile, { recursive: true });
  writeFileSync(join(profile, "AGENTS.md"), "# Main\n\nThe first mate's memory.\n");
  writeFileSync(join(profile, "config.json"), JSON.stringify(profileConfig));
  const config = { enabled: true, memoryHome, profile: "main", ...settings };
  writeFileSync(join(scratch.root, "config", "optchat.json"), JSON.stringify(config));
  return profile;
}

function wireArgs(): string[] {
  const args = settingsArgs(h);
  const at = args.indexOf(FAKE_MODEL);
  return [...args.slice(0, at - 1), ...args.slice(at + 1), "-e", FAKE_ANTHROPIC];
}

const isMains = (turns: readonly Turn[]): boolean =>
  turns.some((turn) => turn.role === "system" && turn.text.includes("You are the first mate"));

const isSummary = (turns: readonly Turn[]): boolean =>
  turns.some((turn) => turn.role === "system" && turn.text.includes("You write OptChat's memory"));

async function until<T>(read: () => T | undefined, what: string): Promise<T> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test("OptChat's cache marks land on the request when the mate's model is a router's virtual model", async () => {
  const model = { provider: "tier", model: "quick", thinking: "off" };
  installMemory(
    { compactor: model, subagent: model },
    { compactorProvider: "tier", compactorModel: "quick" },
  );
  await startMain(lab, scratch, h, false, wireArgs());
  await h.waitFor((event) => event["type"] === "fleet_connected", "main to join the fleet");
  for (let turn = 1; turn <= 4; turn += 1) {
    await cleo.call("comment", { lane: "cleo", text: `Validation step ${String(turn)} passed.` });
    await h.waitForCall(turn - 1, "mate", WAIT_MS);
  }

  const requests = h.wire.filter((call) => call.role === "mate" && !call.warm);
  const last = requests.at(-1);
  assert.ok(last !== undefined && requests.length >= 4, "the mate sent fewer than four requests");
  assert.equal(last.systemMarked, false, "Pi's own mark is still on the system prompt");
  assert.ok(last.markedBlocks.length >= 2, "the view and the request end carry no marks");
  const view = last.markedBlocks.filter((text) => VIEW_LINE.test(text));
  assert.ok(
    view.length >= 1,
    `no mark sits on a block of the memory view: ${last.markedBlocks.join(" | ")}`,
  );
  for (const text of view)
    assert.ok(text.endsWith("\n"), `a view mark is not on a whole block of lines: ${text}`);
});

test("a rate-limited summary model falls back to the profile's next model at once, with no retry on the first", async () => {
  const primary = { provider: "tier", model: "compact", thinking: "off" };
  const spare = { provider: "fake", model: "scripted", thinking: "off" };
  installMemory({ compactor: primary, subagent: spare, compactorFallbacks: [spare] }, {});
  let limited = 0;
  for (let call = 0; call < 50; call += 1)
    h.onModel((turns) => {
      if (isMains(turns)) return { text: "noted" };
      if (limited === 0) {
        limited += 1;
        return { fail: "429 rate limit exceeded" };
      }
      return { text: "user: the parser keeps every field" };
    }, "mate");
  await startMain(lab, scratch, h);
  await h.waitFor((event) => event["type"] === "fleet_connected", "main to join the fleet");
  const long = `Validation continues. ${"The parser keeps every field. ".repeat(40)}`;
  await cleo.call("comment", { lane: "cleo", text: long });

  const models = await until(() => {
    const all = h.modelsOf("mate");
    const summaries = h.callsOf("mate").flatMap((turns, index) => {
      const used = all[index];
      return isSummary(turns) && used !== undefined ? [used] : [];
    });
    return summaries.length >= 2 ? summaries : undefined;
  }, "the summary to be asked twice");
  assert.deepEqual(models.slice(0, 2), ["tier/compact", "fake/scripted"]);
});

test("a summary of an automated [fleet] message is asked for as a notification, not the user's words", async () => {
  const model = { provider: "fake", model: "scripted", thinking: "off" };
  installMemory(
    { compactor: model, subagent: model },
    { compactorProvider: "fake", compactorModel: "scripted" },
  );
  h.onModel(() => ({ text: "noted" }), "mate");
  await startMain(lab, scratch, h);
  await h.waitFor((event) => event["type"] === "fleet_connected", "main to join the fleet");
  const long = `Validation continues. ${"The parser keeps every field. ".repeat(40)}`;
  await cleo.call("comment", { lane: "cleo", text: long });

  const asked = await until(
    () =>
      h
        .callsOf("mate")
        .find((turns) => isSummary(turns) && turns.at(-1)?.text.includes("[fleet]") === true),
    "the summary of the [fleet] message",
  );
  const task = asked.at(-1)?.text ?? "";
  assert.match(task, /automated notification, not typed by the user: tag it "notification:"/);
  assert.match(task, /<input>\nnotification: \[fleet\]/);
});

test("memory in a mate's home never opens a connected-window socket or a pending-report journal", async () => {
  const model = { provider: "fake", model: "scripted", thinking: "off" };
  const profile = installMemory({ compactor: model, subagent: model }, {});
  h.onModel(() => ({ text: "noted" }), "mate");
  await startMain(lab, scratch, h);
  await h.waitFor((event) => event["type"] === "fleet_connected", "main to join the fleet");
  await cleo.call("comment", { lane: "cleo", text: "Are you there?" });
  await h.waitForCall(0, "mate", WAIT_MS);
  await until(
    () => (existsSync(join(scratch.root, "state", "optchat-activation.json")) ? true : undefined),
    "memory to load",
  );

  assert.ok(existsSync(join(profile, "lock.sock")), "the profile lock is not held");
  assert.ok(!existsSync(join(profile, "windows.sock")), "a connected-window socket is open");
  assert.ok(!existsSync(join(profile, "pending-reports.json")), "a pending-report journal exists");
});
