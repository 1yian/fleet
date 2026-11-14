import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { tempDir } from "../support/run-root.ts";

const MAIN = fileURLToPath(new URL("../../packages/cardd/src/main.ts", import.meta.url));

for (const explicit of [true, false]) {
  test(`project registration ${explicit ? "with --repo skips discovery" : "infers only the new project's repo"}`, () => {
    const root = tempDir("fleet-registration-");
    const db = join(root, "cards.db");
    const marker = join(root, "transport-called");
    const clone = join(root, "clone");
    execFileSync("git", ["init", "-q", "-b", "main", clone]);
    execFileSync("git", [
      "-C",
      clone,
      "remote",
      "add",
      "origin",
      "https://github.com/acme/inferred.git",
    ]);
    const cli = (...args: string[]): string => {
      const run = spawnSync("node", [MAIN, ...args, "--db", db], { encoding: "utf8" });
      assert.equal(run.status, 0, run.stderr);
      return run.stdout.trim();
    };
    cli("project", "add", "discoverable", "--delivery", "local-only", "--migrate");
    cli("project", "add", "missing", "--delivery", "direct-PR");
    cli("project", "add", "known", "--delivery", "no-mistakes", "--repo", "acme/known", "--yolo");
    cli("project", "clone", "discoverable", `local=${clone}`);
    const before = cli("project", "list");
    assert.equal(
      before,
      [
        `discoverable: local-only, yolo off, repo not set, local=${clone}`,
        "known: no-mistakes, yolo on, repo acme/known, no clones",
        "missing: direct-PR, yolo off, repo not set, no clones",
      ].join("\n"),
    );
    const hosts = explicit
      ? { local: ["sh", "-c", `touch '${marker}'; exit 1`] }
      : { local: ["sh", "-c"] };
    const added = cli(
      "project",
      "add",
      "new",
      "--delivery",
      "no-mistakes",
      "--clone",
      `local=${clone}`,
      "--hosts",
      JSON.stringify(hosts),
      ...(explicit ? ["--repo", "acme/explicit"] : []),
    );
    const repo = explicit ? "acme/explicit" : "acme/inferred";
    assert.equal(added, `new: added\nnew: repo ${repo}`);
    assert.equal(existsSync(marker), false, "explicit --repo must not invoke the clone transport");
    assert.equal(
      cli("project", "list"),
      `${before}\nnew: no-mistakes, yolo off, repo ${repo}, local=${clone}`,
    );
  });
}
