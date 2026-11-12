import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { FilesFleet } from "../support/files-fleet.ts";
import { FilesPane } from "../support/files-pane.ts";
import { HerdrLab } from "../support/herdr.ts";
import { git } from "../support/remote.ts";
import { tempDir } from "../support/run-root.ts";

let fleet: FilesFleet;
let lab: HerdrLab;
let files: FilesPane;
beforeEach(async () => {
  for (const tool of ["nvim", "fzf"]) {
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

const withoutYazi = (): string =>
  (process.env["PATH"] ?? "")
    .split(delimiter)
    .filter((dir) => dir !== "")
    .map((dir, index) => {
      if (!existsSync(join(dir, "yazi"))) return dir;
      const shim = join(tempDir("files-path-"), String(index));
      mkdirSync(shim);
      for (const entry of readdirSync(dir))
        if (entry !== "yazi" && entry !== "ya") symlinkSync(join(dir, entry), join(shim, entry));
      return shim;
    })
    .join(delimiter);

test("on a host with no yazi the tab fetches the pinned yazi once and shows parent, current and preview columns", async () => {
  const cache = tempDir("files-cache-");
  const fresh = await FilesPane.open(lab, fleet, {
    label: "fresh",
    path: withoutYazi(),
    env: { XDG_CACHE_HOME: cache },
  });
  await fresh.sees("AGENTS.md");
  assert.deepEqual(readdirSync(join(cache, "fleet")), [
    `yazi-26.5.6-${process.platform}-${process.arch}`,
  ]);
  await fresh.type("gd");
  await fresh.sees(new RegExp(`^${escaped(join(fleet.home, "data"))}(\\s.*)?$`, "m"));
  await fresh.hover("note.md");
  const screen = await fresh.sees(/note\.md.*private note/, "note.md beside its preview");
  for (const sibling of ["config", "state", "packages"])
    assert.match(screen, new RegExp(sibling), `the parent column to list ${sibling}`);
  assert.doesNotMatch(screen, /Netrw/);
});

test("j, k, gg, G and / move the cursor, l and h go in and out of folders, and the preview follows", async () => {
  for (const name of ["alpha", "bravo", "zulu"])
    writeFileSync(dataFile(`${name}.md`), `${name} body\n`);
  mkdirSync(dataFile("inner"));
  writeFileSync(dataFile("inner/deep.md"), "deep body\n");
  await goTo("gd", join(fleet.home, "data"));
  await files.type("G");
  await files.sees("zulu body");
  await files.type("k");
  await files.sees("private note");
  await files.type("gg");
  await files.sees("deep.md");
  await files.type("j");
  await files.sees("alpha body");
  await files.type("/");
  await files.sees("Find next:");
  await files.type("bravo");
  await files.press("enter");
  await files.sees("bravo body");
  await files.type("gg");
  await files.type("l");
  await files.sees(new RegExp(`^${escaped(dataFile("inner"))}(\\s.*)?$`, "m"));
  await files.sees("deep body");
  await files.type("h");
  await files.sees(new RegExp(`^${escaped(join(fleet.home, "data"))}(\\s.*)?$`, "m"));
});

const ESC = String.fromCharCode(27);

const colours = (line: string): Set<string> =>
  new Set(
    [...line.matchAll(new RegExp(`${ESC}\\[[0-9;]*38;[25];[0-9;]+m`, "g"))].map(
      (match) => match[0],
    ),
  );

test("the preview highlights source code and keeps a binary file out of the text view", async () => {
  writeFileSync(
    dataFile("sample.ts"),
    'export const answer: number = 42;\nconst greeting = "hello";\n',
  );
  writeFileSync(dataFile("blob.bin"), Buffer.from([0, 1, 2, 3, 255, 0, 7, 9, 0, 0]));
  await goTo("gd", join(fleet.home, "data"));
  await files.hover("sample.ts");
  await files.sees("answer");
  const line = (await lab.coloredScreen(files.pane))
    .split("\n")
    .find((each) => each.includes("answer"));
  assert.ok(line !== undefined);
  assert.ok(colours(line).size >= 3, `expected highlighted code, got ${JSON.stringify(line)}`);
  await files.press("esc");
  await files.hover("blob.bin");
  const binary = await files.screen();
  assert.doesNotMatch(binary, /\uFFFD/);
});

test("a long file name is cut with an ellipsis in the list and in the status line, clear of the permissions", async () => {
  const long = `${"a-very-long-file-name-that-keeps-going".repeat(4)}.md`;
  writeFileSync(dataFile(long), "long name\n");
  await goTo("gd", join(fleet.home, "data"));
  await files.hover("a-very-long");
  await files.press("esc");
  const screen = await files.sees("long name");
  const status = screen.trimEnd().split("\n").at(-1) ?? "";
  assert.match(status, /a-very-long-file-name\S*…\s+-rw/, `status line: ${status}`);
  assert.match(screen, /a-very-long-file-name\S*…\.md/);
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

test("paste into a folder that is not ignored is refused even when the pasted name is, so no unignored copy appears", async () => {
  const exclude = git(
    fleet.home,
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "info/exclude",
  );
  appendFileSync(exclude, ".env\n");
  writeFileSync(join(fleet.home, ".env"), "SECRET=1\n");
  await files.hover(".env");
  await files.type("y");
  await files.type("p");
  await files.sees("Guarded: paste refused");
  assert.deepEqual(
    readdirSync(fleet.home).filter((name) => name.startsWith(".env")),
    [".env"],
  );
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
