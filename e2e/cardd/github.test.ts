import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { linkSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FakeGitHub } from "../support/github.ts";
import { parseRecord } from "../support/json.ts";
import "../support/tool-stubs.ts";

const PR = "https://github.com/example/app/pull/1";

test("GitHub readers keep a complete snapshot across fixture updates and gh merges", (t) => {
  const github = new FakeGitHub();
  const snapshots: string[] = [];
  t.after(() => {
    for (const dir of snapshots) rmSync(dir, { recursive: true, force: true });
  });
  const snapshot = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-gh-snapshot-"));
    const file = join(dir, "prs.json");
    snapshots.push(dir);
    linkSync(github.env["FAKE_GH_STATE"] ?? "", file);
    return file;
  };
  const gh = (args: readonly string[], file?: string): string => {
    const result = spawnSync("gh", args, {
      encoding: "utf8",
      env: {
        ...process.env,
        ...github.env,
        ...(file === undefined ? {} : { FAKE_GH_STATE: file }),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };

  github.setPr(PR, "OPEN", { ci: "pass" });
  const beforeUpdate = snapshot();
  github.setPr(PR, "CLOSED");
  assert.deepEqual(parseRecord(gh(["pr", "view", PR], beforeUpdate)), { url: PR, state: "OPEN" });
  assert.deepEqual(parseRecord(gh(["pr", "view", PR])), { url: PR, state: "CLOSED" });

  github.setPr(PR, "OPEN", { ci: "pass" });
  const beforeMerge = snapshot();
  assert.equal(gh(["pr", "merge", PR]), `merged ${PR}\n`);
  assert.deepEqual(parseRecord(gh(["pr", "view", PR], beforeMerge)), { url: PR, state: "OPEN" });
  assert.deepEqual(parseRecord(gh(["pr", "view", PR])), { url: PR, state: "MERGED" });

  const beforeSlow = snapshot();
  github.slow(1);
  assert.equal(parseRecord(readFileSync(beforeSlow, "utf8"))["$delay"], undefined);
  assert.equal(parseRecord(readFileSync(github.env["FAKE_GH_STATE"] ?? "", "utf8"))["$delay"], 1);
});
