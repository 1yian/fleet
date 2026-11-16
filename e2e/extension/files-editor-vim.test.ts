import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { FilesFleet } from "../support/files-fleet.ts";
import { FilesPane } from "../support/files-pane.ts";
import { HerdrLab } from "../support/herdr.ts";
import { git } from "../support/remote.ts";
import { tempDir } from "../support/run-root.ts";

let fleet: FilesFleet;
let lab: HerdrLab;
let vimOnly: string;
beforeEach(async () => {
  const bin = tempDir("vim-only-bin-");
  for (const tool of ["vim", "git"]) {
    const found = execFileSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).trim();
    symlinkSync(found, join(bin, tool));
  }
  symlinkSync(process.execPath, join(bin, "node"));
  vimOnly = bin;
  fleet = await FilesFleet.start();
  lab = await HerdrLab.start({});
  mkdirSync(join(fleet.home, "data"), { recursive: true });
});
afterEach(async (t) => {
  await lab.printIfFailed(t);
  await Promise.allSettled([lab.stop(), fleet.stop()]);
});

const swapsInHome = (): string[] =>
  execFileSync(
    "find",
    [fleet.home, "-path", "*/node_modules", "-prune", "-o", "-name", ".*.sw?", "-print"],
    { encoding: "utf8" },
  )
    .split("\n")
    .filter(Boolean);

const swapFolder = (state: string): string => join(state, "fleet", "vim", "swap");

const open = (path: string, state: string): Promise<FilesPane> =>
  FilesPane.open(lab, fleet, {
    path: vimOnly,
    env: { XDG_STATE_HOME: state },
    command: `node '${fleet.scratch.launch}' files open '${path}'`,
  });

test("with no nvim on the host, a tracked file reached by :edit from a writable Vim is read-only, and no swap lands in the home", async () => {
  const note = join(fleet.home, "data", "note.md");
  writeFileSync(note, "private note\n");
  const agents = join(fleet.home, "AGENTS.md");
  const before = readFileSync(agents, "utf8");
  const folder = swapFolder(join(fleet.userHome, ".local", "state"));
  const editor = await open(note, "");
  await editor.sees("private note");
  assert.ok(readdirSync(folder).some((name) => name.endsWith("%data%note.md.swp")));
  assert.equal(statSync(folder).mode & 0o777, 0o700);
  await editor.type(`:edit ${agents}`);
  await editor.press("enter");
  await editor.type("ix");
  await editor.sees("E21: Cannot make changes");
  await editor.press("esc");
  assert.equal(readFileSync(agents, "utf8"), before);
  assert.deepEqual(swapsInHome(), []);
  assert.equal(git(fleet.home, "status", "--porcelain"), "");
});

test("netrw is off in a Vim that Files starts, so a folder is not browsed and cannot reset the guard's flags", async () => {
  const note = join(fleet.home, "data", "note.md");
  writeFileSync(note, "private note\n");
  const editor = await open(note, join(fleet.userHome, "state"));
  await editor.sees("private note");
  await editor.type(':echo "netrw=" . get(g:, "loaded_netrwPlugin", 0)');
  await editor.press("enter");
  await editor.sees("netrw=1");
  await editor.type(`:edit ${fleet.home}`);
  await editor.press("enter");
  await editor.sees("is a directory");
});

test("a guarded file that is forced writable still keeps its swap out of the tree, and a written change still shows as modified", async () => {
  const state = join(fleet.userHome, "state");
  const agents = join(fleet.home, "AGENTS.md");
  const editor = await open(agents, state);
  await editor.sees("GUARDED");
  await editor.type(":set modifiable noreadonly write");
  await editor.press("enter");
  await editor.type("ox");
  await editor.press("esc");
  await editor.type(":write");
  await editor.press("enter");
  await editor.sees("written");
  assert.deepEqual(swapsInHome(), []);
  assert.ok(readdirSync(swapFolder(state)).some((name) => name.endsWith("%AGENTS.md.swp")));
  assert.match(git(fleet.home, "status", "--porcelain"), /^M AGENTS\.md$/);
  const check = execFileSync("node", [fleet.scratch.launch, "update", "--check"], {
    encoding: "utf8",
    env: { ...process.env, ...fleet.env() },
  });
  assert.match(check, /refused/);
  assert.match(check, /has uncommitted changes: M AGENTS\.md/);
});

test("work in a Vim that was killed is found in the fleet folder on reopen and can be recovered", async () => {
  const state = join(fleet.userHome, "state");
  const note = join(fleet.home, "data", "note.md");
  writeFileSync(note, "saved line\n");
  const editor = await open(note, state);
  await editor.sees("saved line");
  await editor.type("ounsaved crash line");
  await editor.press("esc");
  await editor.type(":preserve");
  await editor.press("enter");
  await editor.type(':echo "pid=" . getpid()');
  await editor.press("enter");
  const screen = await editor.sees(/pid=\d+/);
  const pid = Number(/pid=(\d+)/.exec(screen)?.[1]);
  assert.ok(pid > 1);
  process.kill(pid, "SIGKILL");
  assert.deepEqual(swapsInHome(), []);
  assert.ok(readdirSync(swapFolder(state)).some((name) => name.endsWith("%data%note.md.swp")));
  const reopened = await open(note, state);
  await reopened.sees("E325: ATTENTION");
  await reopened.sees("fleet/vim/swap/");
  await reopened.press("r");
  await reopened.sees("Recovery completed");
  await reopened.press("enter");
  await reopened.sees("unsaved crash line");
  assert.equal(readFileSync(note, "utf8"), "saved line\n");
  assert.deepEqual(swapsInHome(), []);
});

test("update names a Vim swap in the checkout as an open editor or a crash, and still refuses", () => {
  writeFileSync(join(fleet.home, ".README.md.swp"), "swap");
  const check = execFileSync("node", [fleet.scratch.launch, "update", "--check"], {
    encoding: "utf8",
    env: { ...process.env, ...fleet.env() },
  });
  assert.match(check, /"state":"refused"/);
  assert.match(
    check,
    /has uncommitted changes: \?\? \.README\.md\.swp \(a Vim swap for README\.md: the file is open in an editor, or the swap was left by a crash\)/,
  );
});
