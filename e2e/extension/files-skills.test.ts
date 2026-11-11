import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { FilesMates, until } from "../support/files-mates.ts";
import { parseRecord } from "../support/json.ts";
import { mateArgs } from "../support/scratch.ts";

let mates: FilesMates | undefined;
afterEach(async () => {
  await mates?.stop();
  mates = undefined;
});

const skillText = (description: string): string =>
  `---\nname: lavish\ndescription: ${description}\n---\nbody\n`;

function skillRecord(m: FilesMates): { name: string; path: string }[] {
  const file = join(m.fleet.home, "state", "skills.json");
  const parsed = parseRecord(readFileSync(file, "utf8"));
  const list: unknown = parsed["skills"];
  return Array.isArray(list)
    ? list.map((each: unknown) => {
        const entry = parseRecord(JSON.stringify(each));
        return { name: String(entry["name"]), path: String(entry["path"]) };
      })
    : [];
}

test("in the ystack lane a released skill edits in the scratch, and the lane's own Pi loads the edit before the release", async () => {
  mates = await FilesMates.start({ lane: "ystack" });
  const m = mates;
  const clone = m.fleet.clone;
  const scratch = `${clone}.worktrees/scratch`;
  execFileSync("git", [
    "-C",
    clone,
    "worktree",
    "add",
    "-q",
    "-b",
    "scratch/p620-start",
    scratch,
    "origin/main",
  ]);
  mkdirSync(join(scratch, "skills", "lavish"), { recursive: true });
  const edited = join(scratch, "skills", "lavish", "SKILL.md");
  writeFileSync(edited, skillText("scratch lavish"));
  const laneFile = join(m.fleet.home, "config", "lane.json");
  const config = parseRecord(readFileSync(laneFile, "utf8"));
  const released = join(m.fleet.userHome, ".agents", "skills");
  writeFileSync(
    laneFile,
    JSON.stringify({
      ...config,
      args: [...mateArgs(m.h), "--skill", join(scratch, "skills"), "--skill", released],
    }),
  );

  m.up();
  await until("the lane's skill record", () => {
    try {
      return skillRecord(m).find((skill) => skill.name === "lavish");
    } catch {
      return undefined;
    }
  });
  assert.equal(skillRecord(m).find((skill) => skill.name === "lavish")?.path, edited);

  const table = m.fleet.files(["skills"]);
  assert.match(table.stdout, new RegExp(`lavish: ${edited.replaceAll("/", "\\/")} \\[writable\\]`));
  assert.match(table.stdout, /shadows: .*\.agents\/skills\/lavish\/SKILL\.md \[read-only/);
  assert.match(
    table.stdout,
    /scratch: .* on scratch\/p620-start, 0 ahead and 0 behind origin\/main/,
  );

  m.fleet.forgetEditorCalls();
  const edit = m.fleet.files(["edit", join(released, "lavish", "SKILL.md")]);
  assert.equal(edit.status, 0, edit.stderr);
  const call = m.fleet.editorCalls().at(-1);
  assert.equal(call?.args.at(-1), edited);
  assert.equal(call.args.includes("-R"), false);

  writeFileSync(edited, skillText("scratch lavish, changed"));
  rmSync(join(scratch, "skills", "lavish"), { recursive: true });
  mkdirSync(join(scratch, "skills", "other"), { recursive: true });
  writeFileSync(
    join(scratch, "skills", "other", "SKILL.md"),
    "---\nname: other\ndescription: another\n---\nbody\n",
  );
  const pane = await m.matePane();
  await m.lab.submit(pane, "/reload");
  await until("the released skill to win once the scratch no longer has it", () =>
    skillRecord(m).find((skill) => skill.name === "lavish")?.path ===
    join(released, "lavish", "SKILL.md")
      ? true
      : undefined,
  );
  assert.ok(skillRecord(m).some((skill) => skill.name === "other"));
});
