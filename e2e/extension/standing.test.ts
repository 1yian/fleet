import assert from "node:assert/strict";
import {
  appendFileSync,
  chmodSync,
  readdirSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { Cardd } from "../support/cardd.ts";
import { Harness, type Turn } from "../support/harness.ts";
import { HerdrLab } from "../support/herdr.ts";
import { optionalString, records } from "../support/json.ts";
import { configureMain, mateArgs, Scratch, startMain } from "../support/scratch.ts";

const WAIT_MS = 90_000;
const BIN = fileURLToPath(new URL("../../node_modules/.bin", import.meta.url));
const TRANSPORT = fileURLToPath(new URL("../support/switch-transport.ts", import.meta.url));
const PROBE = fileURLToPath(new URL("../support/probe.ts", import.meta.url));

const MAIN_PREF = "MAIN-DOMAIN-PREF";
const LEO_PREF = "LEO-DOMAIN-PREF";
const SHARED_ONE = "SHARED-PREF-ONE";
const SHARED_TWO = "SHARED-PREF-TWO";
const MAIN_FRESH = "MAIN-FRESH-FACT";
const MAIN_OLD = "MAIN-OLD-FACT";
const MAIN_GONE = "MAIN-GONE-FACT";
const MAIN_NEW = "MAIN-NEW-LEARNING";
const LEO_FRESH = "LEO-FRESH-FACT";
const LEO_OLD = "LEO-OLD-FACT";
const LEO_NEW = "LEO-NEW-LEARNING";
const LEO_PROPOSAL = "LEO-SHARED-PROPOSAL";
const AGENTS_RULE = "AGENTS-RULE-ADDED-AFTER-START";

const daysAgo = (days: number): string =>
  new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
const TODAY = daysAgo(0);

let cardd: Cardd;
let h: Harness;
let lab: HerdrLab;
let here: Scratch;
let p620: Scratch;
let leoHome: string;
let farHome: string;
let piArgs: string[];

async function startLab(superviseMs: number): Promise<void> {
  lab = await HerdrLab.start({
    ...h.piEnv("mate"),
    PATH: `${BIN}:${process.env["PATH"] ?? ""}`,
    FLEET_SUPERVISE_MS: String(superviseMs),
  });
}

beforeEach(async () => {
  cardd = await Cardd.start();
  h = await Harness.start();
  here = new Scratch();
  p620 = new Scratch("fleet");
  const marker = join(here.parent, "p620-down");
  const mainToken = cardd.addLane("main", undefined, here.root);
  configureMain(here, cardd.url, mainToken, {
    hosts: { p620: ["node", TRANSPORT, marker] },
    roots: { p620: p620.root },
  });
  piArgs = [
    ...mateArgs(h).filter((arg) => !["--no-context-files", "--no-builtin-tools"].includes(arg)),
    "-e",
    PROBE,
  ];
  const lane = (name: string): { url: string; token: string; args: string[] } => ({
    url: cardd.url,
    token: cardd.addLane(name, "main"),
    args: piArgs,
  });
  leoHome = here.addLane("leo", lane("leo"));
  farHome = p620.addLane("far", lane("far"));
  mkdirSync(join(farHome, "state"), { recursive: true });
  writeFileSync(join(farHome, "state", "stopped"), "stopped by hand\n");
});
afterEach(async (t) => {
  await lab.printIfFailed(t);
  const stopped = await Promise.allSettled([lab.stop(), h.stop(), cardd.stop()]);
  here.dispose();
  p620.dispose();
  const failed = stopped.find((result) => result.status === "rejected");
  if (failed !== undefined) throw new Error(`cleanup failed: ${String(failed.reason)}`);
});

const dataFile = (home: string, name: string): string => join(home, "data", name);

function put(home: string, name: string, text: string): void {
  mkdirSync(join(home, "data"), { recursive: true });
  writeFileSync(dataFile(home, name), text);
}

const read = (home: string, name: string): string | undefined =>
  existsSync(dataFile(home, name)) ? readFileSync(dataFile(home, name), "utf8") : undefined;

async function until<T>(
  read: () => T | undefined | Promise<T | undefined>,
  what: string,
): Promise<T> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function paneOf(label: string): Promise<string> {
  return until(async () => {
    const workspaces = records((await lab.run(["workspace", "list"]))["workspaces"]);
    const workspace = workspaces.find((each) => each["label"] === label);
    if (workspace === undefined) return undefined;
    const panes = await lab.run(["pane", "list", "--workspace", String(workspace["workspace_id"])]);
    const pane = records(panes["panes"])[0];
    return pane === undefined ? undefined : String(pane["pane_id"]);
  }, `the ${label} workspace`);
}

const systemOf = (turns: readonly Turn[]): string =>
  turns.find((turn) => turn.role === "system")?.text ?? "";

const lastUser = (turns: readonly Turn[]): string =>
  turns.findLast((turn) => turn.role === "user")?.text ?? "";

async function asked(word: string): Promise<Turn[]> {
  return until(
    () => h.callsOf("mate").find((turns) => lastUser(turns).includes(word)),
    `a model call on ${word}`,
  );
}

async function connected(mates: number): Promise<void> {
  await h.waitForNth((event) => event["type"] === "fleet_connected", mates, "the mates to join");
}

async function reloaded(home: string): Promise<void> {
  const cwd = realpathSync(home);
  await until(
    () =>
      h.events.find(
        (event) =>
          event["type"] === "session" &&
          event["reason"] === "reload" &&
          optionalString(event, "cwd") === cwd,
      ),
    `${cwd} to reload`,
  );
}

const readOnly = (file: string): boolean => (statSync(file).mode & 0o222) === 0;

type Move =
  { readonly text: string } | { readonly tool: string; readonly args: Record<string, string> };

function stowScript(plan: (system: string) => Move[]): void {
  for (let call = 0; call < 80; call += 1)
    h.onModel((turns) => {
      const at = turns.findLastIndex(
        (turn) => turn.role === "user" && turn.text.startsWith("[stow]"),
      );
      if (at < 0) return { text: "noted" };
      const done = turns.slice(at).filter((turn) => turn.role === "toolResult").length;
      return plan(systemOf(turns))[done] ?? { text: "Stowed, captain." };
    }, "mate");
}

const write = (path: string, content: string): Move => ({
  tool: "write",
  args: { path, content },
});

function staleLines(message: string): string[] {
  return message
    .split("\n")
    .filter((line) => line.startsWith("- STALE "))
    .sort();
}

function seedMemory(): void {
  put(here.root, "captain.md", `- ${MAIN_PREF}\n`);
  put(here.root, "captain-shared.md", `- ${SHARED_ONE}\n`);
  put(
    here.root,
    "learnings.md",
    [
      `- ${MAIN_FRESH} <!--a:${daysAgo(3)}-->`,
      `- ${MAIN_OLD} <!--a:${daysAgo(45)}-->`,
      `- ${MAIN_GONE} <!--p:${daysAgo(10)}-->`,
      "",
    ].join("\n"),
  );
  put(leoHome, "captain.md", `- ${LEO_PREF}\n`);
  put(
    leoHome,
    "learnings.md",
    [`- ${LEO_FRESH} <!--a:${daysAgo(2)}-->`, `- ${LEO_OLD} <!--a:${daysAgo(31)}-->`, ""].join(
      "\n",
    ),
  );
}

test("every mate loads its own captain preferences and learnings plus main's shared preferences, and main's shared file converges on every host and nothing else crosses homes", async () => {
  await startLab(1000);
  seedMemory();
  const leoCaptain = read(leoHome, "captain.md");
  const leoLearnings = read(leoHome, "learnings.md");
  const mainPane = await startMain(lab, here, h, false, piArgs);
  await connected(2);

  for (const home of [leoHome, farHome])
    await until(
      () => (read(home, "captain-shared.md") === `- ${SHARED_ONE}\n` ? true : undefined),
      `${home} to hold main's shared preferences`,
    );
  assert.ok(readOnly(dataFile(leoHome, "captain-shared.md")), "the copy in leo's home is writable");
  assert.ok(readOnly(dataFile(farHome, "captain-shared.md")), "the copy on p620 is writable");

  const leoPane = await paneOf("2ndmate-leo");
  await lab.submit(mainPane, "HELLO-MAIN");
  await lab.submit(leoPane, "HELLO-LEO");
  const main = systemOf(await asked("HELLO-MAIN"));
  const leo = systemOf(await asked("HELLO-LEO"));
  for (const word of [MAIN_PREF, SHARED_ONE, MAIN_FRESH, MAIN_OLD])
    assert.match(main, RegExp(word));
  for (const word of [LEO_PREF, LEO_FRESH, LEO_OLD]) assert.doesNotMatch(main, RegExp(word));
  for (const word of [LEO_PREF, SHARED_ONE, LEO_FRESH, LEO_OLD]) assert.match(leo, RegExp(word));
  for (const word of [MAIN_PREF, MAIN_FRESH, MAIN_OLD]) assert.doesNotMatch(leo, RegExp(word));

  put(here.root, "captain-shared.md", `- ${SHARED_TWO}\n`);
  for (const home of [leoHome, farHome])
    await until(
      () => (read(home, "captain-shared.md") === `- ${SHARED_TWO}\n` ? true : undefined),
      `${home} to hold the new shared preferences`,
    );
  await lab.submit(leoPane, "HELLO-LEO-AGAIN");
  const again = systemOf(await asked("HELLO-LEO-AGAIN"));
  assert.match(again, RegExp(SHARED_TWO));
  assert.doesNotMatch(again, RegExp(SHARED_ONE));

  rmSync(dataFile(here.root, "captain-shared.md"));
  for (const home of [leoHome, farHome])
    await until(
      () => (existsSync(dataFile(home, "captain-shared.md")) ? undefined : true),
      `${home} to lose the shared preferences main removed`,
    );
  await lab.submit(leoPane, "HELLO-LEO-LAST");
  assert.doesNotMatch(systemOf(await asked("HELLO-LEO-LAST")), RegExp(SHARED_TWO));

  assert.equal(read(leoHome, "captain.md"), leoCaptain);
  assert.equal(read(leoHome, "learnings.md"), leoLearnings);
  assert.equal(read(farHome, "learnings.md"), undefined);
  assert.equal(read(here.root, "captain.md"), `- ${MAIN_PREF}\n`);
  assert.doesNotMatch(read(here.root, "learnings.md") ?? "", /LEO-/);
});

test("/stow in main files what the model curates, publishes main's shared preferences at once, then reloads AGENTS.md and the role contract in the same conversation", async () => {
  await startLab(600_000);
  seedMemory();
  stowScript((system) =>
    system.includes(MAIN_FRESH)
      ? [
          write(
            "data/memory-archive.md",
            `## ${TODAY} stow\n- (from learnings.md) ${MAIN_OLD}\n- ${MAIN_GONE}\n`,
          ),
          write(
            "data/learnings.md",
            `- ${MAIN_FRESH} <!--a:${TODAY}-->\n- ${MAIN_NEW} <!--a:${TODAY}-->\n`,
          ),
          write("data/captain-shared.md", `- ${SHARED_TWO}\n`),
        ]
      : [],
  );
  const mainPane = await startMain(lab, here, h, false, piArgs);
  await connected(2);
  await until(
    () => (read(leoHome, "captain-shared.md") === `- ${SHARED_ONE}\n` ? true : undefined),
    "leo to hold main's shared preferences",
  );
  appendFileSync(join(here.root, "AGENTS.md"), `\n${AGENTS_RULE}\n`);

  await lab.submit(mainPane, "/stow");
  const stowing = await until(
    () =>
      h
        .callsOf("mate")
        .find((turns) => lastUser(turns).includes("[stow]") && systemOf(turns).includes(MAIN_OLD)),
    "main's own stow call",
  );
  const message = lastUser(stowing);
  assert.match(systemOf(stowing), RegExp(MAIN_OLD));
  assert.doesNotMatch(systemOf(stowing), RegExp(AGENTS_RULE));
  assert.match(message, /data\/captain-shared\.md \(editable\)/);
  assert.deepEqual(staleLines(message), [
    `- STALE aging 45d: ${MAIN_OLD}`,
    `- STALE perishable 10d: ${MAIN_GONE}`,
  ]);
  assert.doesNotMatch(message, new RegExp(`${LEO_OLD}|${LEO_PREF}`));

  await reloaded(here.root);
  assert.equal(
    read(here.root, "learnings.md"),
    `- ${MAIN_FRESH} <!--a:${TODAY}-->\n- ${MAIN_NEW} <!--a:${TODAY}-->\n`,
  );
  assert.match(read(here.root, "memory-archive.md") ?? "", RegExp(MAIN_OLD));
  assert.equal(read(leoHome, "captain-shared.md"), `- ${SHARED_TWO}\n`);
  assert.equal(read(farHome, "captain-shared.md"), `- ${SHARED_TWO}\n`);
  assert.equal(read(leoHome, "learnings.md")?.includes(MAIN_NEW), false);

  await lab.submit(mainPane, "HELLO-AFTER-STOW");
  const after = systemOf(await asked("HELLO-AFTER-STOW"));
  assert.match(after, RegExp(AGENTS_RULE));
  assert.match(after, RegExp(MAIN_NEW));
  assert.match(after, RegExp(SHARED_TWO));
  assert.doesNotMatch(after, RegExp(MAIN_OLD));
  assert.doesNotMatch(after, RegExp(MAIN_GONE));
  assert.doesNotMatch(after, RegExp(LEO_PREF));
});

test("/stow in a second mate curates only its own home, leaves main's shared copy alone and routes a shared preference to main, then reloads its AGENTS.md and role contract", async () => {
  await startLab(600_000);
  seedMemory();
  const mainOwn = {
    captain: read(here.root, "captain.md"),
    shared: read(here.root, "captain-shared.md"),
    learnings: read(here.root, "learnings.md"),
  };
  stowScript((system) =>
    system.includes(LEO_FRESH)
      ? [
          write(
            "data/learnings.md",
            `- ${LEO_FRESH} <!--a:${TODAY}-->\n- ${LEO_NEW} <!--a:${TODAY}-->\n`,
          ),
          {
            tool: "comment",
            args: { lane: "leo", text: `Shared preference for the captain: ${LEO_PROPOSAL}` },
          },
        ]
      : [],
  );
  await startMain(lab, here, h, false, piArgs);
  await connected(2);
  await until(
    () => (read(leoHome, "captain-shared.md") === `- ${SHARED_ONE}\n` ? true : undefined),
    "leo to hold main's shared preferences",
  );
  const leoPane = await paneOf("2ndmate-leo");
  appendFileSync(join(leoHome, "AGENTS.md"), `\n${AGENTS_RULE}\n`);

  await lab.submit(leoPane, "/stow");
  const stowing = await asked("[stow]");
  const message = lastUser(stowing);
  assert.match(message, /data\/captain-shared\.md \(read-only: main's copy\)/);
  assert.deepEqual(staleLines(message), [`- STALE aging 31d: ${LEO_OLD}`]);
  assert.doesNotMatch(message, new RegExp(`${MAIN_OLD}|${MAIN_PREF}`));
  assert.doesNotMatch(systemOf(stowing), RegExp(AGENTS_RULE));

  await reloaded(leoHome);
  const proposal = await asked(LEO_PROPOSAL);
  assert.match(lastUser(proposal), /^\[fleet\] leo on c-\d+/);
  assert.equal(
    read(leoHome, "learnings.md"),
    `- ${LEO_FRESH} <!--a:${TODAY}-->\n- ${LEO_NEW} <!--a:${TODAY}-->\n`,
  );
  assert.equal(read(leoHome, "captain-shared.md"), `- ${SHARED_ONE}\n`);
  assert.ok(readOnly(dataFile(leoHome, "captain-shared.md")));
  assert.deepEqual(
    {
      captain: read(here.root, "captain.md"),
      shared: read(here.root, "captain-shared.md"),
      learnings: read(here.root, "learnings.md"),
    },
    mainOwn,
  );

  await lab.submit(leoPane, "HELLO-AFTER-STOW");
  const after = systemOf(await asked("HELLO-AFTER-STOW"));
  assert.match(after, RegExp(AGENTS_RULE));
  assert.match(after, RegExp(LEO_NEW));
  assert.match(after, RegExp(SHARED_ONE));
  assert.doesNotMatch(after, RegExp(LEO_OLD));
  assert.doesNotMatch(after, RegExp(MAIN_FRESH));
});

const preserved = (home: string): string[] =>
  readdirSync(join(home, "data"))
    .filter((name) => name.startsWith("captain-shared.edited-"))
    .sort();

const preservedTexts = (home: string): string[] =>
  preserved(home).map((name) => readFileSync(join(home, "data", name), "utf8"));

function handEdit(home: string, text: string): void {
  const file = dataFile(home, "captain-shared.md");
  chmodSync(file, 0o644);
  writeFileSync(file, text);
}

test("a hand-edited copy of the shared preferences is preserved aside before main replaces or removes it, once, on every host, and a copy nobody edited is replaced quietly", async () => {
  await startLab(1000);
  seedMemory();
  await startMain(lab, here, h, false, piArgs);
  await connected(2);
  for (const home of [leoHome, farHome])
    await until(
      () => (read(home, "captain-shared.md") === `- ${SHARED_ONE}\n` ? true : undefined),
      `${home} to hold main's shared preferences`,
    );

  put(here.root, "captain-shared.md", `- ${SHARED_TWO}\n`);
  for (const home of [leoHome, farHome])
    await until(
      () => (read(home, "captain-shared.md") === `- ${SHARED_TWO}\n` ? true : undefined),
      `${home} to hold the new shared preferences`,
    );
  for (const home of [leoHome, farHome])
    assert.deepEqual(preserved(home), [], `${home} kept a copy of a file nobody edited`);

  const EDIT_ONE = "LEO-HAND-EDIT-ONE";
  const EDIT_FAR = "FAR-HAND-EDIT";
  handEdit(leoHome, `- ${SHARED_TWO}\n- ${EDIT_ONE}\n`);
  handEdit(farHome, `- ${EDIT_FAR}\n`);
  for (const [home, word] of [
    [leoHome, EDIT_ONE],
    [farHome, EDIT_FAR],
  ] as const) {
    await until(
      () => (preserved(home).length === 1 ? true : undefined),
      `${home} to keep the edit`,
    );
    assert.match(preservedTexts(home).join(""), RegExp(word));
    await until(
      () => (read(home, "captain-shared.md") === `- ${SHARED_TWO}\n` ? true : undefined),
      `${home} to hold main's shared preferences again`,
    );
    assert.ok(readOnly(dataFile(home, "captain-shared.md")));
  }

  const leoPane = await paneOf("2ndmate-leo");
  await lab.submit(leoPane, "HELLO-LEO-EDITED");
  const contract = systemOf(await asked("HELLO-LEO-EDITED"));
  assert.match(contract, RegExp(SHARED_TWO));
  assert.doesNotMatch(contract, RegExp(EDIT_ONE));

  put(here.root, "captain-shared.md", `- ${SHARED_ONE}\n`);
  await until(
    () => (read(leoHome, "captain-shared.md") === `- ${SHARED_ONE}\n` ? true : undefined),
    "leo to hold the next shared preferences",
  );
  assert.equal(preserved(leoHome).length, 1, "an untouched copy was preserved again");

  const EDIT_TWO = "LEO-HAND-EDIT-TWO";
  handEdit(leoHome, `- ${EDIT_TWO}\n`);
  rmSync(dataFile(here.root, "captain-shared.md"));
  await until(
    () => (existsSync(dataFile(leoHome, "captain-shared.md")) ? undefined : true),
    "leo to lose the shared preferences main removed",
  );
  await until(
    () => (preserved(leoHome).length === 2 ? true : undefined),
    "leo to keep the second edit",
  );
  assert.match(preservedTexts(leoHome).join(""), RegExp(EDIT_TWO));
  assert.match(preservedTexts(leoHome).join(""), RegExp(EDIT_ONE));
});
