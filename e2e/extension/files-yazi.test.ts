import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { FilesFleet } from "../support/files-fleet.ts";
import { FilesPane } from "../support/files-pane.ts";
import { HerdrLab } from "../support/herdr.ts";

let fleet: FilesFleet;
let lab: HerdrLab;
let files: FilesPane;
beforeEach(async () => {
  for (const tool of ["yazi", "ya", "nvim", "fzf"]) {
    execFileSync("sh", ["-c", `command -v ${tool}`]);
  }
  fleet = await FilesFleet.start();
  lab = await HerdrLab.start({});
  mkdirSync(join(fleet.home, "data"), { recursive: true });
  writeFileSync(join(fleet.home, "data", "note.md"), "private note\n");
  files = await FilesPane.open(lab, fleet);
  await files.sees("AGENTS.md");
});
afterEach(async (t) => {
  await lab.printIfFailed(t);
  await Promise.allSettled([lab.stop(), fleet.stop()]);
});

const dataFile = (name: string): string => join(fleet.home, "data", name);

const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

async function goTo(keys: string, folder: string): Promise<void> {
  await files.type(keys);
  await files.sees(new RegExp(`^${escaped(folder)}(\\s.*)?$`, "m"), `the header to name ${folder}`);
}

test("the lane home shows hidden files, config, data and state, and g d g c g s g h move between them", async () => {
  const home = await files.sees(".gitignore");
  for (const name of ["config", "data", "state", ".git"]) assert.match(home, new RegExp(name));
  await goTo("gd", join(fleet.home, "data"));
  await files.sees("note.md");
  await goTo("gc", join(fleet.home, "config"));
  await files.sees("lane.json");
  await goTo("gs", join(fleet.home, "state"));
  await goTo("gh", fleet.home);
  await files.sees("AGENTS.md");
});

test("Enter on an ignored file opens it writable, with a space in its name", async () => {
  writeFileSync(dataFile("with space.md"), "spaced\n");
  await goTo("gd", join(fleet.home, "data"));
  await files.hover("with space");
  await files.press("enter");
  await files.sees("spaced");
  await files.type("iZ");
  await files.press("esc");
  await files.type(":wq");
  await files.press("enter");
  await files.sees("with space.md");
  assert.equal(readFileSync(dataFile("with space.md"), "utf8"), "Zspaced\n");
});

test("Enter on a tracked file opens it read-only with the reason, and an edit is refused", async () => {
  await files.hover("AGENTS.md");
  await files.press("enter");
  const opened = await files.sees(/GUARDED, tracked in the home of lane cleo/);
  assert.match(opened, /\[RO\]/);
  const before = readFileSync(join(fleet.home, "AGENTS.md"), "utf8");
  await files.type("ix");
  await files.sees("E21: Cannot make changes");
  await files.type(":q");
  await files.press("enter");
  await files.sees("(filter: AGENTS.md)");
  assert.equal(readFileSync(join(fleet.home, "AGENTS.md"), "utf8"), before);
});

test("rename, create, delete and paste in a guarded place are refused and change nothing", async () => {
  await files.hover("AGENTS.md");
  for (const [key, action] of [
    ["r", "rename"],
    ["d", "remove"],
    ["a", "create"],
  ] as const) {
    await files.type(key);
    await files.sees(`Guarded: ${action} refused`);
    await files.sees("tracked in the home of lane cleo");
  }
  assert.ok(existsSync(join(fleet.home, "AGENTS.md")));
  await goTo("gd", join(fleet.home, "data"));
  await files.hover("note.md");
  await files.type("y");
  await goTo("gh", fleet.home);
  await files.type("p");
  await files.sees("Guarded: paste refused");
  assert.equal(existsSync(join(fleet.home, "note.md")), false);
});

const copies = (): string[] =>
  readdirSync(join(fleet.home, "data")).filter((name) => name.startsWith("fresh-renamed"));

async function eventually(what: string, done: () => boolean): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!done()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

test("rename, create, copy and delete in an ignored place work", async () => {
  await goTo("gd", join(fleet.home, "data"));
  await files.type("a");
  await files.sees("Create:");
  await files.type("fresh.md");
  await files.press("enter");
  await eventually("the new file", () => existsSync(dataFile("fresh.md")));
  await files.hover("fresh.md");
  await files.type("r");
  await files.sees("Rename:");
  await files.press("backspace", "backspace", "backspace");
  await files.type("-renamed.md");
  await files.press("enter");
  await eventually("the rename", () => existsSync(dataFile("fresh-renamed.md")));
  assert.equal(existsSync(dataFile("fresh.md")), false);
  await files.hover("fresh-renamed");
  await files.type("y");
  await files.type("p");
  await eventually("the copy", () => copies().length === 2);
  await files.type("d");
  await files.sees("Trash");
  await files.type("y");
  await eventually("the delete", () => copies().length === 1);
});

test("rename is checked where the new name lands, so a name that leaves the folder for a tracked file is refused", async () => {
  await goTo("gd", join(fleet.home, "data"));
  await files.hover("note.md");
  await files.type("r");
  await files.sees("Rename:");
  await files.press(..."note.md".split("").map(() => "backspace"));
  await files.type("../README.md");
  await files.press("enter");
  await files.sees("Guarded: rename refused");
  await files.sees("tracked in the home of lane cleo");
  assert.equal(readFileSync(dataFile("note.md"), "utf8"), "private note\n");
});

test("paste is checked for the file it would make, so a name that is a link to a tracked file is refused", async () => {
  const agents = join(fleet.home, "AGENTS.md");
  const before = readFileSync(agents, "utf8");
  writeFileSync(join(fleet.home, "state", "linked.md"), "from state\n");
  symlinkSync(agents, dataFile("linked.md"));
  await goTo("gs", join(fleet.home, "state"));
  await files.hover("linked.md");
  await files.type("y");
  await goTo("gd", join(fleet.home, "data"));
  await files.type("p");
  await files.sees("Guarded: paste refused");
  assert.equal(readFileSync(agents, "utf8"), before);
});

test("a cut from a guarded place cannot be pasted anywhere", async () => {
  await files.hover("AGENTS.md");
  await files.type("x");
  await goTo("gd", join(fleet.home, "data"));
  await files.type("p");
  await files.sees("Guarded: paste refused");
  assert.ok(existsSync(join(fleet.home, "AGENTS.md")));
  assert.equal(existsSync(dataFile("AGENTS.md")), false);
});

test("g p picks a project clone with fzf and goes there, and g k goes to the skill folders", async () => {
  await files.type("gp");
  await files.sees("clone>");
  await files.sees("clone fleet");
  await files.press("enter");
  await files.sees(
    new RegExp(`^${escaped(fleet.clone)}(\\s.*)?$`, "m"),
    "the header to name the clone",
  );
  await files.type("gk");
  await files.sees(/^~\/\.agents\/skills\s*$/m, "the header to name the released skills");
  await files.sees("lavish");
});
