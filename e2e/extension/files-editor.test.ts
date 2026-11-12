import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
  ftruncateSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { FilesFleet } from "../support/files-fleet.ts";
import { FilesPane } from "../support/files-pane.ts";
import { HerdrLab } from "../support/herdr.ts";

let fleet: FilesFleet;
let lab: HerdrLab;
beforeEach(async () => {
  execFileSync("sh", ["-c", "command -v nvim"]);
  fleet = await FilesFleet.start();
  lab = await HerdrLab.start({});
  mkdirSync(join(fleet.home, "data"), { recursive: true });
});
afterEach(async (t) => {
  await lab.printIfFailed(t);
  await Promise.allSettled([lab.stop(), fleet.stop()]);
});

test("a tracked file opened from inside a writable editor session is read-only too", async () => {
  const note = join(fleet.home, "data", "note.md");
  writeFileSync(note, "private note\n");
  const agents = join(fleet.home, "AGENTS.md");
  const before = readFileSync(agents, "utf8");
  const editor = await FilesPane.open(lab, fleet, {
    command: `node '${fleet.scratch.launch}' files open '${note}'`,
  });
  await editor.sees("private note");
  await editor.type(`:edit ${agents}`);
  await editor.press("enter");
  await editor.type("ix");
  await editor.sees("E21: Cannot make changes");
  assert.equal(readFileSync(agents, "utf8"), before);
});

test("S shows the exact sha256 of a file too large to read into memory at once", async () => {
  const big = join(fleet.home, "data", "huge.log");
  const size = 2 * 1024 ** 3 + 1024 ** 2;
  const fd = openSync(big, "w");
  ftruncateSync(fd, size);
  closeSync(fd);
  const hash = createHash("sha256");
  const zeros = Buffer.alloc(1024 ** 2);
  for (let done = 0; done < size; done += zeros.length) hash.update(zeros);
  const expected = hash.digest("hex").slice(0, 12);
  const pane = await FilesPane.open(lab, fleet, {
    command: `node '${fleet.scratch.launch}' files show lane '${big}'`,
  });
  await pane.sees(`sha256 ${expected}.`);
  await pane.press("esc");
  await pane.sees("cancelled, nothing was typed");
});
