import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { CardSchema, check } from "@fleet/protocol";
import { FilesFleet } from "../support/files-fleet.ts";
import { git } from "../support/remote.ts";

let fleet: FilesFleet;
beforeEach(async () => {
  fleet = await FilesFleet.start();
});
afterEach(async () => {
  await fleet.stop();
});

function opened(path: string): { guarded: boolean; status: number; stderr: string } {
  fleet.forgetEditorCalls();
  const run = fleet.files(["open", path]);
  const [call] = fleet.editorCalls();
  assert.ok(call !== undefined, `the editor was not started for ${path}: ${run.stderr}`);
  assert.equal(call.args.at(-1), path);
  assert.equal(call.args.at(-2), "--");
  assert.ok(call.args.includes("autoread") || call.args.includes("set autoread"));
  const guarded = call.args.includes("-R") && call.args.includes("-M");
  assert.equal(call.args.includes("-R"), call.args.includes("-M"));
  return { guarded, status: run.status, stderr: run.stderr };
}

test("a tracked file and a new unignored file in a lane home open read-only, an ignored file opens writable", () => {
  assert.equal(opened(join(fleet.home, "AGENTS.md")).guarded, true);
  const fresh = join(fleet.home, "notes.md");
  writeFileSync(fresh, "new\n");
  assert.equal(opened(fresh).guarded, true);
  const ignored = join(fleet.home, "data", "note.md");
  writeFileSync(ignored, "mine\n");
  assert.equal(opened(ignored).guarded, false);
  const configured = join(fleet.home, "config", "lane.json");
  assert.equal(opened(configured).guarded, false);
  const state = join(fleet.home, "state", "starts");
  writeFileSync(state, "1\n");
  assert.equal(opened(state).guarded, false);
});

test("the editor's status line says why a file is guarded", () => {
  fleet.forgetEditorCalls();
  fleet.files(["open", join(fleet.home, "AGENTS.md")]);
  const [call] = fleet.editorCalls();
  const status = call?.args.find((arg) => arg.startsWith("let &statusline"));
  assert.match(status ?? "", /GUARDED, tracked in the home of lane cleo/);
});

test("a tracked file in the fleet checkout and in a project clone opens read-only", () => {
  assert.equal(opened(join(fleet.scratch.root, "AGENTS.md")).guarded, true);
  assert.equal(opened(join(fleet.clone, "AGENTS.md")).guarded, true);
  const fresh = join(fleet.clone, "draft.md");
  writeFileSync(fresh, "x\n");
  assert.equal(opened(fresh).guarded, true);
  mkdirSync(join(fleet.clone, "data"), { recursive: true });
  const ignored = join(fleet.clone, "data", "private.md");
  writeFileSync(ignored, "y\n");
  assert.equal(opened(ignored).guarded, false);
});

test("a worker worktree is read-only whole, and a scratch worktree is writable", () => {
  const worker = join(`${fleet.clone}.worktrees`, "c-7-a1");
  git(fleet.clone, "worktree", "add", "-q", "-b", "c-7-a1", worker);
  assert.equal(opened(join(worker, "AGENTS.md")).guarded, true);
  mkdirSync(join(worker, "data"), { recursive: true });
  const ignored = join(worker, "data", "scratch.txt");
  writeFileSync(ignored, "z\n");
  assert.equal(opened(ignored).guarded, true);
  const scratch = join(`${fleet.clone}.worktrees`, "scratch");
  git(fleet.clone, "worktree", "add", "-q", "-b", "scratch/by-hand", scratch);
  assert.equal(opened(join(scratch, "AGENTS.md")).guarded, false);
});

test("a binary file and a file over 2 MiB show their metadata and never reach the editor", () => {
  const binary = join(fleet.home, "data", "lifecycle.db");
  writeFileSync(binary, Buffer.from([83, 81, 76, 0, 1, 2, 3]));
  const big = join(fleet.home, "data", "big.log");
  writeFileSync(big, "x".repeat(2 * 1024 * 1024 + 1));
  for (const [path, why] of [
    [binary, "a binary file"],
    [big, "larger than 2 MiB"],
  ] as const) {
    fleet.forgetEditorCalls();
    const run = fleet.files(["open", path]);
    assert.equal(run.status, 0);
    assert.deepEqual(fleet.editorCalls(), []);
    assert.match(run.stdout, new RegExp(`not opened in a text editor: ${why}`));
    assert.match(run.stdout, /size \d+ bytes/);
  }
});

test("a released skill file is read-only in every lane, by its path and not by its file mode", () => {
  const skill = join(fleet.userHome, ".agents", "skills", "lavish", "SKILL.md");
  assert.equal(opened(skill).guarded, true);
  assert.equal(opened(join(fleet.released, "lavish", "SKILL.md")).guarded, true);
  const piAgent = join(fleet.userHome, ".pi", "agent", "skills");
  mkdirSync(join(piAgent, "mine"), { recursive: true });
  writeFileSync(join(piAgent, "mine", "SKILL.md"), "---\nname: mine\n---\n");
  assert.equal(opened(join(piAgent, "mine", "SKILL.md")).guarded, true);
  const laneSkills = join(fleet.home, "data", "skills", "own");
  mkdirSync(laneSkills, { recursive: true });
  writeFileSync(join(laneSkills, "SKILL.md"), "---\nname: own\n---\n");
  assert.equal(opened(join(laneSkills, "SKILL.md")).guarded, false);
});

test("a skill folder that links into a live git checkout is read-only through the link too", () => {
  const checkout = join(fleet.scratch.parent, "ystack-checkout");
  mkdirSync(join(checkout, "skills", "axi"), { recursive: true });
  execFileSync("git", ["init", "-q", checkout]);
  writeFileSync(join(checkout, "skills", "axi", "SKILL.md"), "---\nname: axi\n---\n");
  symlinkSync(join(checkout, "skills", "axi"), join(fleet.released, "axi"));
  assert.equal(opened(join(fleet.userHome, ".agents", "skills", "axi", "SKILL.md")).guarded, true);
  assert.equal(opened(join(checkout, "skills", "axi", "SKILL.md")).guarded, true);
});

test("check exits 1 and says why for a guarded path, and 0 for a private one", () => {
  const guarded = fleet.files(["check", join(fleet.home, "AGENTS.md")]);
  assert.equal(guarded.status, 1);
  assert.match(guarded.stderr, /guarded, tracked in the home of lane cleo/);
  assert.equal(fleet.files(["check", join(fleet.home, "data", "x.md")]).status, 0);
  assert.equal(fleet.files(["check", fleet.userHome]).status, 0);
});

test("with cardd down and no saved project list, a clone file is refused and not taken for a private one", async () => {
  await fleet.cardd.stop();
  const clone = join(fleet.clone, "AGENTS.md");
  const refused = fleet.files(["check", clone]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /guarded, cardd cannot be reached and no earlier project list/);
  assert.equal(fleet.files(["check", join(fleet.home, "data", "x.md")]).status, 0);
  assert.equal(fleet.files(["check", join(fleet.home, "AGENTS.md")]).status, 1);
  const edit = fleet.files(["edit", clone]);
  assert.equal(edit.status, 1);
  assert.match(edit.stderr, /no earlier project list/);
  assert.equal(existsSync(`${fleet.clone}.worktrees/scratch`), false);
  mkdirSync(join(fleet.home, "state", "files"), { recursive: true });
  writeFileSync(join(fleet.home, "state", "files", "projects.json"), "{not json");
  assert.equal(fleet.files(["check", clone]).status, 1);
});

test("with cardd down, the project list saved by an earlier run still guards the clone", async () => {
  const clone = join(fleet.clone, "AGENTS.md");
  assert.match(fleet.files(["check", clone]).stderr, /guarded, tracked in the fleet clone/);
  await fleet.cardd.stop();
  const again = fleet.files(["check", clone]);
  assert.equal(again.status, 1);
  assert.match(again.stderr, /guarded, tracked in the fleet clone/);
});

test("rename and create check where the file will land, not only where it is", () => {
  const data = join(fleet.home, "data");
  const note = join(data, "note.md");
  writeFileSync(note, "mine\n");
  const readme = join(fleet.home, "README.md");
  const before = readFileSync(readme, "utf8");
  const escape = fleet.files(["rename", note, join(data, "..", "README.md")]);
  assert.equal(escape.status, 1);
  assert.match(escape.stderr, /README\.md: guarded, tracked in the home of lane cleo/);
  assert.equal(readFileSync(readme, "utf8"), before);
  assert.equal(readFileSync(note, "utf8"), "mine\n");
  const renamed = join(data, "renamed.md");
  const moved = fleet.files(["rename", note, renamed]);
  assert.equal(moved.status, 0, moved.stderr);
  assert.equal(existsSync(note), false);
  assert.equal(readFileSync(renamed, "utf8"), "mine\n");
  writeFileSync(note, "second\n");
  const taken = fleet.files(["rename", note, renamed]);
  assert.equal(taken.status, 1);
  assert.match(taken.stderr, /already exists/);
  assert.equal(readFileSync(renamed, "utf8"), "mine\n");
  assert.equal(
    fleet.files(["rename", join(fleet.home, "AGENTS.md"), join(data, "a.md")]).status,
    1,
  );

  const nested = join(data, "deep", "new.md");
  assert.equal(fleet.files(["create", nested]).status, 0);
  assert.equal(readFileSync(nested, "utf8"), "");
  assert.equal(fleet.files(["create", `${join(data, "tree")}/`]).status, 0);
  assert.ok(statSync(join(data, "tree")).isDirectory());
  const outside = fleet.files(["create", join(data, "..", "fresh.md")]);
  assert.equal(outside.status, 1);
  assert.match(outside.stderr, /fresh\.md: guarded, tracked in the home of lane cleo/);
  assert.equal(existsSync(join(fleet.home, "fresh.md")), false);
  assert.match(fleet.files(["create", nested]).stderr, /already exists/);
});

test("a folder that holds a force-added tracked file is guarded whole, and so cannot be moved away", () => {
  const folder = join(fleet.home, "data", "kept");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "tracked.md"), "t\n");
  writeFileSync(join(folder, "loose.md"), "l\n");
  git(fleet.home, "add", "-f", "data/kept/tracked.md");
  assert.equal(fleet.files(["check", folder]).status, 1);
  assert.equal(fleet.files(["check", join(folder, "tracked.md")]).status, 1);
  assert.equal(fleet.files(["check", join(folder, "loose.md")]).status, 0);
  const moved = fleet.files(["rename", folder, join(fleet.home, "data", "elsewhere")]);
  assert.equal(moved.status, 1);
  assert.match(moved.stderr, /guarded, tracked in the home of lane cleo/);
  assert.equal(readFileSync(join(folder, "tracked.md"), "utf8"), "t\n");
});

test("roots lists the home, its private folders, the clone, the skill folders and the worktrees of the lane's own cards", async () => {
  const mate = await fleet.cardd.connect(fleet.laneToken);
  const card = check(
    CardSchema,
    await mate.call("card.new", { title: "explorer card", kind: "scout", project: "fleet" }),
  );
  const mine = join(`${fleet.clone}.worktrees`, `c-${String(card.id)}-a1`);
  const other = join(`${fleet.clone}.worktrees`, "c-999-a1");
  git(fleet.clone, "worktree", "add", "-q", "-b", "c-mine", mine);
  git(fleet.clone, "worktree", "add", "-q", "-b", "c-other", other);
  mkdirSync(join(fleet.home, "data", "reports"), { recursive: true });
  const run = fleet.files(["roots"]);
  assert.equal(run.status, 0, run.stderr);
  const rows = new Map(
    run.stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [name = "", path = ""] = line.split("\t");
        return [name, path];
      }),
  );
  assert.equal(rows.get("home"), fleet.home);
  assert.equal(rows.get("data"), join(fleet.home, "data"));
  assert.equal(rows.get("config"), join(fleet.home, "config"));
  assert.equal(rows.get("state"), join(fleet.home, "state"));
  assert.equal(rows.get("reports"), join(fleet.home, "data", "reports"));
  assert.equal(rows.get("clone fleet"), fleet.clone);
  assert.equal(rows.get("skills released"), join(fleet.userHome, ".agents", "skills"));
  assert.equal(rows.get(`worker fleet c-${String(card.id)}-a1`), mine);
  assert.equal(rows.has("worker fleet c-999-a1"), false);
  await mate.close();
});
