// Main's home is the repo (docs/setup.md). A Pi started in the repo loads the fleet extension
// from the repo's own .pi/settings.json, gets main's private charter, and loads conversation
// memory through the user's own loader. `fleet migrate` moves the earlier layout into the repo
// without losing main's records or its conversations, and undoes itself. All of it runs in a
// scratch copy of the repo, against a scratch cardd and the scripted model.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { Cardd, type Session } from "../support/cardd.ts";
import { Harness } from "../support/harness.ts";
import { HerdrLab } from "../support/herdr.ts";
import { isRecord, parseRecord } from "../support/json.ts";
import { mateArgs, Scratch, startMain } from "../support/scratch.ts";

const WAIT_MS = 60_000;
const BIN = fileURLToPath(new URL("../../node_modules/.bin", import.meta.url));

let cardd: Cardd;
let h: Harness;
let lab: HerdrLab;
let scratch: Scratch;
let ghost: Session;
let mainToken: string;
let scratchDir: string;
beforeEach(async () => {
  cardd = await Cardd.start();
  h = await Harness.start();
  scratch = new Scratch();
  scratchDir = mkdtempSync(join(tmpdir(), "fleet-earlier-"));
  mainToken = cardd.addLane("main", undefined, scratch.root);
  ghost = await cardd.connect(cardd.addLane("ghost", "main"));
  lab = await HerdrLab.start({ ...h.piEnv("mate"), PATH: `${BIN}:${process.env["PATH"] ?? ""}` });
});
afterEach(async () => {
  const stopped = await Promise.allSettled([ghost.close(), lab.stop(), h.stop(), cardd.stop()]);
  scratch.dispose();
  const failed = stopped.find((result) => result.status === "rejected");
  if (failed !== undefined) throw new Error(`cleanup failed: ${String(failed.reason)}`);
});

/** Pi's folder for a working folder's conversations, as Pi names it. */
const sessionFolder = (cwd: string): string =>
  join(h.dir, "agent", "sessions", `--${realpathSync(cwd).slice(1).replaceAll("/", "-")}--`);

/** An earlier home: a plain folder with a charter, a calm choice, and one conversation. */
function earlierHome(name: string, charter: string): string {
  const home = join(scratchDir, "homes", name);
  mkdirSync(join(home, "config"), { recursive: true });
  writeFileSync(join(home, "AGENTS.md"), charter);
  writeFileSync(join(home, "config", "calm"), "on\n");
  mkdirSync(sessionFolder(home), { recursive: true });
  const header = { type: "session", version: 3, id: `${name}-1`, cwd: realpathSync(home) };
  const message = {
    type: "message",
    id: "m1",
    message: { role: "user", content: `hello ${name}` },
  };
  writeFileSync(
    join(sessionFolder(home), `${name}.jsonl`),
    `${JSON.stringify(header)}\n${JSON.stringify(message)}\n`,
  );
  return home;
}

const migrate = (...args: string[]): string =>
  scratch.fleet(["migrate", "--from", join(scratchDir, "config"), ...args], {
    PI_CODING_AGENT_DIR: join(h.dir, "agent"),
  });

/** The earlier layout: a settings file for each mate, and the homes they name. */
function earlierLayout(): { main: string; cleo: string } {
  const main = earlierHome("main", "# Main lane\n\nCharter text only main has.\n");
  const cleo = earlierHome("cleo", "# Cleo\n\nCleo owns the startup product.\n");
  mkdirSync(join(scratchDir, "config"));
  const lane = (name: string, home: string): void => {
    writeFileSync(
      join(scratchDir, "config", `${name}.json`),
      JSON.stringify({
        url: cardd.url,
        token: name === "main" ? mainToken : cardd.addLane(name, "main", home),
        home,
        args: mateArgs(h),
      }),
    );
  };
  lane("main", main);
  lane("cleo", cleo);
  return { main, cleo };
}

test("fleet migrate moves the earlier layout into the repo, keeps what it replaced, and undoes itself", () => {
  const { main, cleo } = earlierLayout();
  const lines = migrate();
  assert.match(lines, /main: home .* 1 conversations copied/);
  assert.match(lines, /cleo: home .* 1 conversations copied/);

  // Main's home is the repo. Its charter and its calm choice are now private files in it.
  const laneFile = parseRecord(readFileSync(join(scratch.root, "config", "lane.json"), "utf8"));
  assert.equal(laneFile["lane"], "main");
  assert.equal(
    readFileSync(join(scratch.root, "data", "charter.md"), "utf8"),
    "# Main lane\n\nCharter text only main has.\n",
  );
  assert.equal(readFileSync(join(scratch.root, "config", "calm"), "utf8"), "on\n");
  // Cleo's home is a worktree of the repo.
  const home = `${scratch.root}.worktrees/lane-cleo`;
  assert.equal(
    parseRecord(readFileSync(join(home, "config", "lane.json"), "utf8"))["lane"],
    "cleo",
  );
  assert.match(
    readFileSync(join(home, "data", "charter.md"), "utf8"),
    /Cleo owns the startup product/,
  );
  assert.ok(existsSync(join(home, ".pi", "settings.json")));

  // Each conversation is copied to the new home's folder with its folder rewritten.
  const [file = ""] = readdirSync(sessionFolder(scratch.root));
  const copied = readFileSync(join(sessionFolder(scratch.root), file), "utf8").split("\n");
  assert.equal(parseRecord(copied[0] ?? "")["cwd"], realpathSync(scratch.root));
  assert.match(copied[1] ?? "", /hello main/);

  // Nothing of the earlier layout is changed, except that the settings are renamed.
  assert.ok(existsSync(join(main, "AGENTS.md")) && existsSync(join(cleo, "AGENTS.md")));
  assert.ok(existsSync(join(sessionFolder(main), "main.jsonl")));
  assert.deepEqual(readdirSync(join(scratchDir, "config")).sort(), [
    "cleo.json.migrated",
    "main.json.migrated",
  ]);
  assert.match(migrate(), /^nothing to migrate/);

  // Undoing puts the settings back and sets the new files aside, so the new layout starts no lane.
  assert.match(migrate("--undo"), /main: settings restored/);
  assert.deepEqual(readdirSync(join(scratchDir, "config")).sort(), ["cleo.json", "main.json"]);
  assert.ok(existsSync(join(scratch.root, "config", "lane.json.undone")));
  assert.equal(scratch.fleet(["status", "--json"], { HERDR_SESSION: lab.name }).trim(), "[]");
});

test("a plain pi in the repo is main: it loads the fleet extension from the repo, its charter, and memory", async () => {
  earlierLayout();
  migrate();
  // The user's own memory loader, as Firstmate installs it. It stays idle unless FM_HOME is set.
  const loader = join(h.dir, "agent", "extensions", "fm-optchat");
  mkdirSync(loader, { recursive: true });
  writeFileSync(
    join(loader, "index.ts"),
    `import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const home = process.env["FM_HOME"];
export default function () {
  if (home === undefined) return;
  mkdirSync(join(home, "state"), { recursive: true });
  writeFileSync(join(home, "state", "optchat-activation.json"), JSON.stringify({ home, cwd: process.cwd() }));
}
`,
  );
  writeFileSync(join(scratch.root, "config", "optchat.json"), JSON.stringify({ enabled: true }));
  // The charter arrived with the migration. Ghost, a lane with no mate, wakes main.
  h.onModel(() => ({ text: "noted" }), "mate");
  await startMain(lab, scratch, h);
  const card: unknown = await ghost.call("card.new", { title: "Ship the fix", kind: "scout" });
  const id: unknown = Reflect.get(Object(card), "id");
  await ghost.call("hold", { card: id, question: "Ship the fix?", options: ["Yes"] });
  const turns = await h.waitForCall(0, "mate", WAIT_MS);

  const system = turns.find((turn) => turn.role === "system")?.text ?? "";
  assert.match(system, /You are the first mate/);
  assert.match(system, /Charter text only main has/);
  const receipt = parseRecord(
    readFileSync(join(scratch.root, "state", "optchat-activation.json"), "utf8"),
  );
  assert.equal(receipt["home"], realpathSync(scratch.root));
});

test("a worker in a worktree of the repo starts with only the extension it was given, and no installed packages", async () => {
  const wt = `${scratch.root}.worktrees/c-9-a1`;
  execFileSync("git", ["-C", scratch.root, "worktree", "add", "-q", "--detach", wt, "HEAD"]);
  const token = cardd.addLane("wt", "main");
  const extension = join(scratch.root, "packages", "extension", "src", "index.ts");
  // A token can start with "-", so each fleet flag goes to Pi as --flag=value.
  const fleet = [`--fleet-url=${cardd.url}`, `--fleet-token=${token}`, "--fleet-role=mate"];
  const args = [...mateArgs(h), "-e", extension, ...fleet];
  const created = await lab.run([
    "workspace",
    "create",
    "--cwd",
    wt,
    "--label",
    "wt",
    "--no-focus",
  ]);
  const root = created["root_pane"];
  const pane = isRecord(root) ? String(root["pane_id"]) : "";
  await lab.submit(pane, `pi ${args.map((arg) => `'${arg}'`).join(" ")}`);
  const main = await cardd.connect(mainToken);
  await main.call("comment", { lane: "wt", text: "Are you there?" });
  const turns = await h.waitForCall(0, "mate", WAIT_MS).catch(async (error: unknown) => {
    throw new Error(`${String(error)}\n${await lab.screen(pane)}`, { cause: error });
  });
  assert.match(turns.map((turn) => turn.text).join("\n"), /Are you there\?/);
  await main.close();
});
