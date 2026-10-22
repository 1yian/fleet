import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
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
import { configureMain, mateArgs, Scratch, startMain } from "../support/scratch.ts";
import { tempDir } from "../support/run-root.ts";

const WAIT_MS = 60_000;
const BIN = fileURLToPath(new URL("../../node_modules/.bin", import.meta.url));
const DOTFILES = process.env["FLEET_DOTFILES"] ?? join(homedir(), "Projects", "dotfiles");
const PINNED_LOADER_REF =
  process.env["FLEET_DOTFILES_REF"] ?? "b1abeff18f245f49f05f19088cc2f0e377dc5a50";
const AGENT_FILES = ["home/.pi/agent/extensions/fm-optchat", "home/.pi/agent/optchat"];
const PACKAGE = dirname(fileURLToPath(import.meta.resolve("pi-optchat/package.json")));
const PROBE = fileURLToPath(new URL("../support/probe.ts", import.meta.url));
const NOTICE = "[fleet]";
const IDLE_WORD = "PINEAPPLE";
const BUSY_WORD = "KUMQUAT";

let cardd: Cardd;
let h: Harness;
let lab: HerdrLab;
let scratch: Scratch;
let cleo: Session;
let memoryHome: string;
let mainToken: string;
beforeEach(async () => {
  cardd = await Cardd.start();
  h = await Harness.start();
  scratch = new Scratch("fleet");
  mainToken = cardd.addLane("main", undefined, scratch.root);
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

const dotfiles = (...args: string[]): Buffer =>
  execFileSync("git", ["-C", DOTFILES, ...args], { stdio: ["ignore", "pipe", "pipe"] });

function installLoader(): void {
  const agent = join(h.dir, "agent");
  const listed = dotfiles("ls-tree", "-r", "--name-only", PINNED_LOADER_REF, "--", ...AGENT_FILES);
  for (const file of listed.toString("utf8").split("\n").filter(Boolean)) {
    const target = join(agent, file.replace(/^home\/\.pi\/agent\//, ""));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, dotfiles("show", `${PINNED_LOADER_REF}:${file}`));
  }
}

function installMemory(): void {
  installLoader();
  const agent = join(h.dir, "agent");
  const prepared = join(scratch.root, "config", "optchat", "package");
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

const isMains = (turns: readonly Turn[]): boolean =>
  turns.some((turn) => turn.role === "system" && turn.text.includes("You are the first mate"));

const mentions = (turns: readonly Turn[], word: string): boolean =>
  turns.some((turn) => turn.text.includes(word));

const labels = (text: string): number => text.split(NOTICE).length - 1;

function assertLabelled(text: string, what: string): void {
  const message = text.replace(/^<chat>[\s\S]*<\/chat>/, "");
  assert.ok(message.startsWith(`${NOTICE} `), `${what} does not start with ${NOTICE}: ${text}`);
  assert.equal(labels(text), 1, `${what} has ${NOTICE} more than once: ${text}`);
  assert.ok(!text.includes("Operational notification"), `${what} has the old notice: ${text}`);
}

function userTurn(calls: readonly (readonly Turn[])[], word: string): string {
  const found = calls.flat().find((turn) => turn.role === "user" && turn.text.includes(word));
  assert.ok(found !== undefined, `the model never got a user turn with ${word}`);
  return found.text;
}

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
  "with memory on, main yields silently and keeps idle and mid-turn fleet messages in conversation memory",
  { skip: existsSync(DOTFILES) ? false : `no dotfiles checkout at ${DOTFILES}` },
  async () => {
    installMemory();
    for (let call = 0; call < 50; call += 1)
      h.onModel((turns) => {
        const last = turns.at(-1);
        if (isMains(turns) && last?.role === "user" && last.text.includes(IDLE_WORD))
          return { tool: "slow_tool" };
        return isMains(turns) ? { tool: "yield" } : { text: "noted" };
      }, "mate");
    await startMain(lab, scratch, h);
    await h.waitFor((event) => event["type"] === "fleet_connected", "main to join the fleet");
    const session = await h.waitFor((event) => event["type"] === "session", "main's session");

    await cleo.call("comment", { lane: "cleo", text: `Validation continues: ${IDLE_WORD}.` });
    const first = await h.waitFor(
      (event) => event["type"] === "tool_waiting" || event["type"] === "settled",
      "main's turn on the idle message",
    );
    assert.equal(first["type"], "tool_waiting", "main's turn on the idle message ended early");

    await cleo.call("comment", { lane: "cleo", text: `Still validating: ${BUSY_WORD}.` });
    await h.waitForNth((event) => event["type"] === "fleet_delivered", 2, "the mid-turn message");
    h.releaseTool();
    await h.waitFor((event) => event["type"] === "settled", "main's turn to end");

    const calls = h.callsOf("mate").filter(isMains);
    assert.ok(
      calls.some((turns) => mentions(turns, IDLE_WORD)),
      "the model never got the idle message",
    );
    assert.ok(
      calls.some((turns) => turns.at(-1)?.role === "user" && mentions(turns, BUSY_WORD)),
      "the model never got the mid-turn message",
    );
    for (const word of [IDLE_WORD, BUSY_WORD])
      assertLabelled(userTurn(calls, word), `the model's ${word} message`);
    const settled = h.events.filter((event) => event["type"] === "settled");
    assert.deepEqual(
      settled.map((event) => event["aborted"]),
      settled.map(() => false),
    );
    const file = optionalString(session, "file") ?? "";
    const messages = readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map(parseRecord)
      .map((entry) => entry["message"])
      .filter(isRecord);
    assert.deepEqual(
      messages.filter((message) => message["stopReason"] === "error"),
      [],
      "a turn ended with an error",
    );
    const assistant = messages.filter((message) => message["role"] === "assistant");
    assert.equal(assistant.length, 3);
    for (const message of assistant) {
      const content = message["content"];
      assert.ok(Array.isArray(content));
      assert.deepEqual(
        content.filter(isRecord).map((block) => block["type"]),
        ["toolCall"],
      );
    }

    const items = await until(() => {
      const found = jsonl(join(memoryHome, "profiles", "main", "main"));
      const both = [IDLE_WORD, BUSY_WORD].map((word) => withText(found, word));
      return both.every((item) => item !== undefined) ? both : undefined;
    }, "both messages in the memory journal");
    for (const item of items) {
      assert.equal(item["kind"], "user");
      assertLabelled(String(item["text"]), "the journal item");
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

test(
  "a second mate whose home got memory from `fleet home memory` keeps a [fleet] message in its own memory",
  { skip: existsSync(DOTFILES) ? false : `no dotfiles checkout at ${DOTFILES}` },
  async () => {
    installLoader();
    const agent = { PI_CODING_AGENT_DIR: join(h.dir, "agent") };
    const token = cardd.addLane("leo", "main");
    const home = scratch.addLane("leo", {
      url: cardd.url,
      token,
      args: [...mateArgs(h), "-e", PROBE],
    });
    const made = scratch.fleet(["home", "memory", "leo", "--source", PACKAGE], agent);
    assert.match(made, /leo: package: prepared/);
    assert.match(made, /leo: profile: leo, new/);
    const again = scratch.fleet(["home", "memory", "leo", "--source", PACKAGE], agent);
    assert.equal(again.match(/is there already/g)?.length, 3, again);

    h.onModel(() => ({ text: "noted" }), "mate");
    scratch.fleet(["up", "leo"], { ...agent, HERDR_SESSION: lab.name });
    await h.waitFor((event) => event["type"] === "fleet_connected", "leo to join the fleet");
    const main = await cardd.connect(mainToken);
    await main.call("comment", { lane: "leo", text: `Ship the parser: ${IDLE_WORD}.` });
    await main.close();

    await until(
      () => (h.callsOf("mate").some((turns) => mentions(turns, IDLE_WORD)) ? true : undefined),
      "leo's model to get the message",
    );
    const receipt = await until(() => {
      const file = join(home, "state", "optchat-activation.json");
      return existsSync(file) ? parseRecord(readFileSync(file, "utf8")) : undefined;
    }, "leo's memory to load");
    assert.equal(receipt["profile"], "leo");
    assert.equal(receipt["memoryHome"], join(realpathSync(home), "data", "optchat"));
    const item = await until(
      () => withText(jsonl(join(home, "data", "optchat", "profiles", "leo", "main")), IDLE_WORD),
      "the message in leo's memory journal",
    );
    assert.equal(item["kind"], "user");
    assertLabelled(String(item["text"]), "leo's journal item");
    assertLabelled(userTurn(h.callsOf("mate"), IDLE_WORD), "leo's model message");
    assert.ok(!existsSync(join(scratch.root, "state", "optchat-activation.json")));
  },
);

test(
  "`fleet home memory` turns a second mate's memory back on after it was set off",
  { skip: existsSync(DOTFILES) ? false : `no dotfiles checkout at ${DOTFILES}` },
  async () => {
    installLoader();
    const agent = { PI_CODING_AGENT_DIR: join(h.dir, "agent") };
    const token = cardd.addLane("board", "main");
    const home = scratch.addLane("board", {
      url: cardd.url,
      token,
      args: [...mateArgs(h), "-e", PROBE],
    });
    scratch.fleet(
      ["home", "memory", "board", "--source", PACKAGE, "--compactor", "fake/scripted"],
      agent,
    );
    const settings = join(home, "config", "optchat.json");
    const written = parseRecord(readFileSync(settings, "utf8"));
    writeFileSync(settings, JSON.stringify({ ...written, enabled: false }));

    const again = scratch.fleet(["home", "memory", "board", "--source", PACKAGE], agent);
    assert.match(again, /board: settings: turned memory on in config\/optchat.json/);
    assert.deepEqual(parseRecord(readFileSync(settings, "utf8")), written);
    const third = scratch.fleet(["home", "memory", "board", "--source", PACKAGE], agent);
    assert.equal(third.match(/is there already/g)?.length, 3, third);

    h.onModel(() => ({ text: "noted" }), "mate");
    scratch.fleet(["up", "board"], { ...agent, HERDR_SESSION: lab.name });
    await h.waitFor((event) => event["type"] === "fleet_connected", "board to join the fleet");
    const main = await cardd.connect(mainToken);
    await main.call("comment", { lane: "board", text: `Ship the plugin: ${IDLE_WORD}.` });
    await main.close();

    const receipt = await until(() => {
      const file = join(home, "state", "optchat-activation.json");
      return existsSync(file) ? parseRecord(readFileSync(file, "utf8")) : undefined;
    }, "board's memory to load");
    assert.equal(receipt["profile"], "board");
    assert.equal(receipt["memoryHome"], join(realpathSync(home), "data", "optchat"));
    const item = await until(
      () => withText(jsonl(join(home, "data", "optchat", "profiles", "board", "main")), IDLE_WORD),
      "the message in board's memory journal",
    );
    assert.equal(item["kind"], "user");
  },
);

test(
  "`fleet home memory` prepares a second mate's package again when the loader no longer accepts it",
  { skip: existsSync(DOTFILES) ? false : `no dotfiles checkout at ${DOTFILES}` },
  async () => {
    installLoader();
    const agent = { PI_CODING_AGENT_DIR: join(h.dir, "agent") };
    const token = cardd.addLane("cnp", "main");
    const home = scratch.addLane("cnp", {
      url: cardd.url,
      token,
      args: [...mateArgs(h), "-e", PROBE],
    });
    scratch.fleet(
      ["home", "memory", "cnp", "--source", PACKAGE, "--compactor", "fake/scripted"],
      agent,
    );
    const browser = join(home, "config", "optchat", "package", "src", "browser.ts");
    writeFileSync(browser, `${readFileSync(browser, "utf8")}\nexport const stale = true;\n`);

    const again = scratch.fleet(["home", "memory", "cnp", "--source", PACKAGE], agent);
    assert.match(again, /cnp: package: prepared again in config\/optchat\/package/);
    assert.ok(!readFileSync(browser, "utf8").includes("stale"), "the stale package stayed");
    const third = scratch.fleet(["home", "memory", "cnp", "--source", PACKAGE], agent);
    assert.equal(third.match(/is there already/g)?.length, 3, third);

    h.onModel(() => ({ text: "noted" }), "mate");
    scratch.fleet(["up", "cnp"], { ...agent, HERDR_SESSION: lab.name });
    await h.waitFor((event) => event["type"] === "fleet_connected", "cnp to join the fleet");
    const main = await cardd.connect(mainToken);
    await main.call("comment", { lane: "cnp", text: `Ship the report: ${IDLE_WORD}.` });
    await main.close();

    const receipt = await until(() => {
      const file = join(home, "state", "optchat-activation.json");
      return existsSync(file) ? parseRecord(readFileSync(file, "utf8")) : undefined;
    }, "cnp's memory to load");
    assert.equal(receipt["profile"], "cnp");
    await until(
      () => withText(jsonl(join(home, "data", "optchat", "profiles", "cnp", "main")), IDLE_WORD),
      "the message in cnp's memory journal",
    );
  },
);
