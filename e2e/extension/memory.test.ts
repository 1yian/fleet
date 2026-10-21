// Main with conversation memory on (docs/setup.md). Main's memory is the captain's own loader,
// fm-optchat from his dotfiles, and the pinned pi-optchat package it prepares. Every [fleet]
// message must reach main's model and main's memory like any other message: one that arrives
// while main is idle starts a turn, and one that arrives mid-turn follows it. The memory journal
// keeps both as notification entries, which merge into the tree with the rest of the talk.
//
// The loader is private, so the test reads it from a dotfiles checkout at a pinned commit:
// FLEET_DOTFILES (default ~/Projects/dotfiles) at FLEET_DOTFILES_REF (default the commit below).
// Without a checkout, as in CI, the test is skipped. Main, cardd, and the model are scratch.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { Cardd, type Session } from "../support/cardd.ts";
import { Harness, type Turn } from "../support/harness.ts";
import { HerdrLab } from "../support/herdr.ts";
import { isRecord, optionalString, parseRecord, type JsonRecord } from "../support/json.ts";
import { configureMain, Scratch, startMain } from "../support/scratch.ts";

const WAIT_MS = 60_000;
const BIN = fileURLToPath(new URL("../../node_modules/.bin", import.meta.url));
const DOTFILES = process.env["FLEET_DOTFILES"] ?? join(homedir(), "Projects", "dotfiles");
// The loader that treats any turn-starting custom message as a notification:
// https://github.com/1yian/dotfiles/pull/34. Bump it when the loader changes.
const REF = process.env["FLEET_DOTFILES_REF"] ?? "44c622fac3fbc5af288c3f123800eae67fc2d792";
const AGENT_FILES = ["home/.pi/agent/extensions/fm-optchat", "home/.pi/agent/optchat"];
const PACKAGE = dirname(fileURLToPath(import.meta.resolve("pi-optchat/package.json")));
const NOTICE = "[firstmate] Operational notification (fleet)";
const IDLE_WORD = "PINEAPPLE";
const BUSY_WORD = "KUMQUAT";

let cardd: Cardd;
let h: Harness;
let lab: HerdrLab;
let scratch: Scratch;
let cleo: Session;
let memoryHome: string;
beforeEach(async () => {
  cardd = await Cardd.start();
  h = await Harness.start();
  scratch = new Scratch();
  configureMain(scratch, cardd.url, cardd.addLane("main", undefined, scratch.root));
  cleo = await cardd.connect(cardd.addLane("cleo", "main"));
  // The profile's lock socket must fit the 103-byte socket path of macOS, so memory sits in /tmp.
  memoryHome = mkdtempSync("/tmp/fleet-memory-");
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

const dotfiles = (...args: string[]): Buffer =>
  execFileSync("git", ["-C", DOTFILES, ...args], { stdio: ["ignore", "pipe", "pipe"] });

/**
 * Installs memory the way the captain does: the loader and the package helper into the Pi agent
 * folder, the pinned package prepared into main's home, a profile, and config/optchat.json.
 */
function installMemory(): void {
  const agent = join(h.dir, "agent");
  const listed = dotfiles("ls-tree", "-r", "--name-only", REF, "--", ...AGENT_FILES);
  for (const file of listed.toString("utf8").split("\n").filter(Boolean)) {
    const target = join(agent, file.replace(/^home\/\.pi\/agent\//, ""));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, dotfiles("show", `${REF}:${file}`));
  }
  const prepared = join(scratch.root, "config", "optchat", "package");
  // The helper runs only when its path is its real path, and the temporary folder is a symlink on macOS.
  const helper = realpathSync(join(agent, "optchat", "package.mjs"));
  execFileSync("node", [helper, "prepare", PACKAGE, prepared], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.ok(existsSync(prepared), "the package helper did not prepare the package");
  const profile = join(memoryHome, "profiles", "main");
  mkdirSync(profile, { recursive: true });
  writeFileSync(join(profile, "AGENTS.md"), "# Main\n\nThe first mate's memory.\n");
  const model = { provider: "fake", model: "scripted", thinking: "off" };
  writeFileSync(
    join(profile, "config.json"),
    JSON.stringify({ compactor: model, subagent: model }),
  );
  const config = { enabled: true, package: "config/optchat/package", memoryHome, profile: "main" };
  writeFileSync(join(scratch.root, "config", "optchat.json"), JSON.stringify(config));
}

/** A call that main's model gets for its own turn, not one from the memory's compactor. */
const isMains = (turns: readonly Turn[]): boolean =>
  turns.some((turn) => turn.role === "system" && turn.text.includes("You are the first mate"));

const mentions = (turns: readonly Turn[], word: string): boolean =>
  turns.some((turn) => turn.text.includes(word));

/** The records of every .jsonl file under a folder. */
function jsonl(folder: string): JsonRecord[] {
  if (!existsSync(folder)) return [];
  return readdirSync(folder, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".jsonl"))
    .flatMap((file) => readFileSync(join(folder, file), "utf8").split("\n"))
    .filter((line) => line.trim() !== "")
    .map(parseRecord);
}

const withText = (found: readonly JsonRecord[], word: string): JsonRecord | undefined =>
  found.find((item) => String(item["text"]).includes(word));

async function until<T>(read: () => T | undefined, what: string): Promise<T> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test(
  "with memory on, main's model and memory get a [fleet] message that arrives idle and one that arrives mid-turn",
  { skip: existsSync(DOTFILES) ? false : `no dotfiles checkout at ${DOTFILES}` },
  async () => {
    installMemory();
    // Main's turn for the idle message runs a tool that waits, so the second message comes mid-turn.
    // Calls from the memory's compactor, if any, answer "ok".
    for (let call = 0; call < 50; call += 1)
      h.onModel((turns) => {
        const last = turns.at(-1);
        if (isMains(turns) && last?.role === "user" && last.text.includes(IDLE_WORD))
          return { tool: "slow_tool" };
        return { text: "noted" };
      }, "mate");
    await startMain(lab, scratch, h);
    await h.waitFor((event) => event["type"] === "fleet_connected", "main to join the fleet");
    const session = await h.waitFor((event) => event["type"] === "session", "main's session");

    await cleo.call("comment", { lane: "cleo", text: `The build is green: ${IDLE_WORD}.` });
    // The idle message starts a turn. With the earlier loader, the memory cancelled that turn
    // before the model ran.
    const first = await h.waitFor(
      (event) => event["type"] === "tool_waiting" || event["type"] === "settled",
      "main's turn on the idle message",
    );
    assert.equal(first["type"], "tool_waiting", "main's turn on the idle message ended early");

    await cleo.call("comment", { lane: "cleo", text: `Approve the merge: ${BUSY_WORD}.` });
    await h.waitForNth((event) => event["type"] === "fleet_delivered", 2, "the mid-turn message");
    h.releaseTool();
    await h.waitFor((event) => event["type"] === "settled", "main's turn to end");

    // The model got both messages in main's own turns.
    const calls = h.callsOf("mate").filter(isMains);
    assert.ok(
      calls.some((turns) => mentions(turns, IDLE_WORD)),
      "the model never got the idle message",
    );
    assert.ok(
      calls.some((turns) => turns.at(-1)?.role === "user" && mentions(turns, BUSY_WORD)),
      "the model never got the mid-turn message",
    );
    // No turn was cut short.
    const settled = h.events.filter((event) => event["type"] === "settled");
    assert.deepEqual(
      settled.map((event) => event["aborted"]),
      settled.map(() => false),
    );
    const file = optionalString(session, "file") ?? "";
    const errors = readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map(parseRecord)
      .map((entry) => entry["message"])
      .filter((message) => isRecord(message) && message["stopReason"] === "error");
    assert.deepEqual(errors, [], "a turn ended with an error");

    // The journal holds both as notification entries, and the tree merges them like any other.
    const items = await until(() => {
      const found = jsonl(join(memoryHome, "profiles", "main", "main"));
      const both = [IDLE_WORD, BUSY_WORD].map((word) => withText(found, word));
      return both.every((item) => item !== undefined) ? both : undefined;
    }, "both messages in the memory journal");
    for (const item of items) {
      assert.equal(item["kind"], "user");
      assert.ok(
        String(item["text"]).startsWith(NOTICE),
        `not a notification: ${String(item["text"])}`,
      );
    }
    const tree = await until(() => {
      const found = jsonl(join(memoryHome, "profiles", "main", "tree"));
      const merged = found.some(
        (node) =>
          Number(node["l"]) > 0 &&
          String(node["text"]).includes(`notification: ${NOTICE}`) &&
          String(node["text"]).includes(IDLE_WORD),
      );
      return merged ? found : undefined;
    }, "the idle message merged in the memory tree");
    for (const word of [IDLE_WORD, BUSY_WORD]) {
      const leaf = tree.find((node) => node["l"] === 0 && String(node["text"]).includes(word));
      assert.ok(String(leaf?.["text"]).startsWith(`notification: ${NOTICE}`));
    }
  },
);
