import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { boundBoardFile } from "../support/board.ts";
import { spawnGuarded } from "../support/guarded.ts";
import { tempDir } from "../support/run-root.ts";

boundBoardFile();

const KANBAN = fileURLToPath(new URL("./kanban.test.ts", import.meta.url));

test("kanban exits after two fixture failures before a browser page exists", async () => {
  const fault = join(tempDir("seed-fault-"), "locked.mjs");
  writeFileSync(
    fault,
    `import { DatabaseSync } from "node:sqlite";
const prepare = DatabaseSync.prototype.prepare;
DatabaseSync.prototype.prepare = function (sql) {
  if (sql.includes("VALUES (?, 'mate:main', 'cleanup', ?, ?, ?)")) {
    throw new Error("injected database is locked");
  }
  return prepare.call(this, sql);
};
`,
  );
  const env = { ...process.env };
  Reflect.deleteProperty(env, "NODE_TEST_CONTEXT");
  const child = spawnGuarded(
    process.execPath,
    [
      `--import=${fault}`,
      "--test",
      "--test-reporter=tap",
      "--test-name-pattern=one swimlane|physically separate",
      KANBAN,
    ],
    { env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString()));
  const deadline = setTimeout(() => {
    if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
  }, 30_000);
  const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => {
        resolve([code, signal]);
      });
    },
  ).finally(() => {
    clearTimeout(deadline);
  });
  assert.equal(signal, null, output);
  assert.equal(code, 1, output);
  assert.match(output, /injected database is locked/);
  assert.match(output, /# tests 2\n/);
  assert.match(output, /# fail 2\n/);
  assert.match(output, /# cancelled 0\n/);
});
