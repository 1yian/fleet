import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { Cardd, type Session } from "../support/cardd.ts";
import { Harness, type Turn } from "../support/harness.ts";
import { HerdrLab } from "../support/herdr.ts";
import { configureMain, Scratch, settingsArgs, startMain } from "../support/scratch.ts";
import { tempDir } from "../support/run-root.ts";

const FAKE_MODEL = fileURLToPath(new URL("../support/fake-model.ts", import.meta.url));
const FAKE_ANTHROPIC = fileURLToPath(new URL("../support/fake-anthropic.ts", import.meta.url));
const CACHE_LIFETIME_MS = 15_000;
const BIN = fileURLToPath(new URL("../../node_modules/.bin", import.meta.url));
const FOLD_TOKENS = 10_000;
const MESSAGES = 7;
const FILLER = "lorem ipsum dolor sit amet ".repeat(450);

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

function installMemory(extra: Record<string, unknown>): void {
  const profile = join(memoryHome, "profiles", "main");
  mkdirSync(profile, { recursive: true });
  writeFileSync(join(profile, "AGENTS.md"), "# Main\n\nThe first mate's memory.\n");
  const model = { provider: "fake", model: "scripted", thinking: "off" };
  writeFileSync(
    join(profile, "config.json"),
    JSON.stringify({ compactor: model, subagent: model }),
  );
  const config = { enabled: true, memoryHome, profile: "main", ...extra };
  writeFileSync(join(scratch.root, "config", "optchat.json"), JSON.stringify(config));
}

const isMains = (turns: readonly Turn[]): boolean =>
  turns.some((turn) => turn.role === "system" && turn.text.includes("You are the first mate"));

const viewOf = (turns: readonly Turn[]): string => {
  const first = turns.find((turn) => turn.role === "user");
  return /<chat>[\s\S]*?<\/chat>/.exec(first?.text ?? "")?.[0] ?? "";
};

const extendsPrevious = (before: readonly Turn[], after: readonly Turn[]): boolean =>
  before.every((turn, index) => {
    const next = after[index];
    return next?.role === turn.role && next.text === turn.text;
  });

async function converse(): Promise<Turn[][]> {
  h.onModel((turns) => (isMains(turns) ? { tool: "yield" } : { text: "noted" }), "mate");
  await startMain(lab, scratch, h);
  await h.waitFor((event) => event["type"] === "fleet_connected", "main to join the fleet");
  for (let n = 1; n <= MESSAGES; n += 1) {
    await cleo.call("comment", { lane: "cleo", text: `Message ${String(n)}. ${FILLER}` });
    await h.waitForNth((event) => event["type"] === "settled", n, `main's turn ${String(n)}`);
  }
  return h.callsOf("mate").filter(isMains);
}

test("fold mode keeps the prompt prefix byte-stable and folds into the view once at the threshold", async () => {
  installMemory({ mode: "fold", foldTokens: FOLD_TOKENS });
  const calls = await converse();
  assert.ok(calls.length >= MESSAGES, `main made ${String(calls.length)} calls`);

  const broken = calls.flatMap((after, index) =>
    index > 0 && !extendsPrevious(calls[index - 1] ?? [], after) ? [index] : [],
  );
  assert.equal(broken.length, 1, `the prefix changed before calls ${broken.join(", ")}`);
  const views = new Set(calls.map(viewOf));
  assert.equal(views.size, 2, "the view should be rebuilt exactly once, at the fold");
  const at = broken[0] ?? 0;
  assert.ok(
    (calls[at] ?? []).length < (calls[at - 1] ?? []).length,
    "the fold did not drop the plain history it moved into the view",
  );
  const last = calls.at(-1) ?? [];
  assert.ok(extendsPrevious(calls[at] ?? [], last), "the chat did not grow plainly after the fold");
});

test("without a mode, the view is rebuilt every turn, as before", async () => {
  installMemory({});
  const calls = await converse();
  const broken = calls.flatMap((after, index) =>
    index > 0 && !extendsPrevious(calls[index - 1] ?? [], after) ? [index] : [],
  );
  assert.ok(
    broken.length >= MESSAGES - 1,
    `the prefix held for ${String(calls.length - broken.length)} calls`,
  );
});

function cachedArgs(): string[] {
  const args = settingsArgs(h);
  const at = args.indexOf(FAKE_MODEL);
  return [...args.slice(0, at - 1), ...args.slice(at + 1), "-e", FAKE_ANTHROPIC];
}

const pause = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

async function chatAfterGap(gapMs: number): Promise<Turn[][]> {
  h.onModel((turns) => (isMains(turns) ? { tool: "yield" } : { text: "noted" }), "mate");
  mkdirSync(join(h.dir, "agent"), { recursive: true });
  writeFileSync(
    join(h.dir, "agent", "settings.json"),
    JSON.stringify({ defaultProvider: "tier", defaultModel: "auto" }),
  );
  await startMain(lab, scratch, h, false, cachedArgs());
  await h.waitFor((event) => event["type"] === "fleet_connected", "main to join the fleet");
  for (let n = 1; n <= 3; n += 1) {
    if (n === 3) await pause(gapMs);
    await cleo.call("comment", { lane: "cleo", text: `Message ${String(n)}.` });
    await h.waitForNth((event) => event["type"] === "settled", n, `main's turn ${String(n)}`);
  }
  return h.callsOf("mate").filter(isMains);
}

const rebuilds = (calls: readonly Turn[][]): number => new Set(calls.map(viewOf)).size - 1;

test("a run that starts after the cache lifetime folds below foldTokens", async () => {
  installMemory({ mode: "fold" });
  const calls = await chatAfterGap(CACHE_LIFETIME_MS + 1_000);
  assert.equal(rebuilds(calls), 1, "the idle gap should fold once");
});

test("a run that starts inside the cache lifetime does not fold", async () => {
  installMemory({ mode: "fold" });
  const calls = await chatAfterGap(0);
  assert.equal(rebuilds(calls), 0);
});

test("foldOnCacheExpiry false keeps the fold for the token threshold only", async () => {
  installMemory({ mode: "fold", foldOnCacheExpiry: false });
  const calls = await chatAfterGap(CACHE_LIFETIME_MS + 1_000);
  assert.equal(rebuilds(calls), 0);
});
