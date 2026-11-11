import assert from "node:assert/strict";
import { mkdirSync, statfsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { isRecord, parseRecord, records } from "../support/json.ts";
import { tempDir } from "../support/run-root.ts";
import { fleet, fleetResult } from "../support/scratch-files.ts";

test("scratch ranks the largest directories of several roots together, and the report lists the roots that share a filesystem", () => {
  const dir = tempDir("fleet-host-dir-");
  const first = tempDir("fleet-root-a-");
  const second = tempDir("fleet-root-b-");
  for (const [root, name, files] of [
    [first, "a-small", 3],
    [first, "a-mid", 10],
    [second, "b-huge", 40],
    [second, "b-big", 25],
    [second, "b-mid", 12],
    [second, "b-few", 5],
  ] as const) {
    mkdirSync(join(root, name));
    for (let index = 0; index < files; index += 1)
      writeFileSync(join(root, name, `f${String(index)}`), "x");
  }

  const together = parseRecord(
    fleet(["scratch", "--largest", first, "--largest", second, "--by", "inodes", "--json"], {})
      .trim()
      .split("\n")
      .at(-1) ?? "",
  );
  assert.deepEqual(
    records(together["largest"]).map((each) => [each["name"], each["inodes"]]),
    [
      [join(second, "b-huge"), 41],
      [join(second, "b-big"), 26],
      [join(second, "b-mid"), 13],
      [join(first, "a-mid"), 11],
      [join(second, "b-few"), 6],
    ],
  );
  const alone = parseRecord(
    fleet(["scratch", "--largest", first, "--by", "inodes", "--json"], {}).trim(),
  );
  assert.deepEqual(
    records(alone["largest"]).map((each) => each["name"]),
    [join(first, "a-mid"), join(first, "a-small")],
  );

  const report = parseRecord(fleet(["scratch", "--json"], { FLEET_HOST_DIR: dir }).trim());
  const shared = records(report["filesystems"]).find((each) =>
    Array.isArray(each["roots"]) ? each["roots"].includes(dir) : false,
  );
  assert.ok(shared !== undefined, "the host folder is a root of a reported filesystem");
  const roots = shared["roots"];
  assert.ok(Array.isArray(roots));
  assert.equal(shared["path"], roots[0]);
  assert.ok(roots.includes(process.env["TMPDIR"]));
  assert.ok(roots.indexOf(process.env["TMPDIR"]) < roots.indexOf(dir));
  assert.equal(new Set(roots).size, roots.length);
});

test("the directory budget stops the walk: a spent budget returns what was counted, says partial, and leaves the rest unscanned", () => {
  const first = tempDir("fleet-root-a-");
  const second = tempDir("fleet-root-b-");
  const files = 4000;
  for (const root of [first, second]) {
    for (const name of ["x", "y"]) {
      mkdirSync(join(root, name));
      for (let index = 0; index < files; index += 1)
        writeFileSync(join(root, name, `f${String(index)}`), "x");
    }
  }
  const started = Date.now();
  const out = parseRecord(
    fleet(["scratch", "--largest", first, "--largest", second, "--by", "inodes", "--json"], {
      FLEET_SCRATCH_WALK_MS: "1",
    })
      .trim()
      .split("\n")
      .at(-1) ?? "",
  );
  assert.ok(Date.now() - started < 20_000, "the call returned promptly");
  assert.equal(out["partial"], true);
  assert.ok(
    records(out["largest"]).every((each) => !String(each["name"]).startsWith(second)),
    "the later root was not reached after the budget was spent",
  );
  const counted = records(out["largest"]).map((each) => Number(each["inodes"]));
  assert.ok(counted.length < 4, "the walk stopped before it reached every child");
  assert.ok(
    counted.every((inodes) => inodes < files + 1),
    "no child was counted in full",
  );
});

test("a watched root that cannot be read is skipped and the others still answer, and when none can be read the call fails", () => {
  const first = tempDir("fleet-root-a-");
  mkdirSync(join(first, "a-dir"));
  for (let index = 0; index < 3; index += 1)
    writeFileSync(join(first, "a-dir", `f${String(index)}`), "x");
  const missing = join(first, "does-not-exist");

  const out = parseRecord(
    fleet(["scratch", "--largest", first, "--largest", missing, "--by", "inodes", "--json"], {})
      .trim()
      .split("\n")
      .at(-1) ?? "",
  );
  assert.deepEqual(
    records(out["largest"]).map((each) => [each["name"], each["inodes"]]),
    [[join(first, "a-dir"), 4]],
  );
  assert.equal(out["partial"], false);

  const none = fleetResult(["scratch", "--largest", missing, "--by", "inodes", "--json"], {});
  assert.notEqual(none.status, 0);
  assert.ok(none.stderr.includes(`none of ${missing} could be read`), none.stderr);
});

test("scratch reports the use of the filesystems it writes to, and names the largest directories by inodes or by space", () => {
  const dir = tempDir("fleet-host-dir-");
  const tree = tempDir("fleet-tree-");
  for (const [name, files] of [
    ["many-small", 30],
    ["some", 10],
    ["few", 3],
  ] as const) {
    mkdirSync(join(tree, name));
    for (let index = 0; index < files; index += 1)
      writeFileSync(join(tree, name, `f${String(index)}`), "x");
  }
  writeFileSync(join(tree, "few", "big.bin"), Buffer.alloc(8 * 1024 * 1024, 1));

  const report = parseRecord(fleet(["scratch", "--json"], { FLEET_HOST_DIR: dir }).trim());
  const filesystems = records(report["filesystems"]);
  const tmp = filesystems.find((each) => each["path"] === "/tmp");
  assert.ok(tmp !== undefined, "the report names /tmp");
  const total = Number(tmp["bytesTotal"]);
  const used = Number(tmp["bytesUsed"]);
  const seen = statfsSync("/tmp");
  const expected = (seen.blocks - seen.bfree) * seen.bsize;
  assert.ok(total > 0 && Math.abs(used - expected) < total * 0.05, "bytes used match statfs");
  assert.ok(isRecord(report) && typeof report["host"] === "string");

  const byInodes = parseRecord(
    fleet(["scratch", "--largest", tree, "--by", "inodes", "--json"], {}).trim(),
  );
  assert.deepEqual(
    records(byInodes["largest"]).map((each) => [each["name"], each["inodes"]]),
    [
      [join(tree, "many-small"), 31],
      [join(tree, "some"), 11],
      [join(tree, "few"), 5],
    ],
  );
  const bySpace = parseRecord(
    fleet(["scratch", "--largest", tree, "--by", "space", "--json"], {}).trim(),
  );
  assert.equal(records(bySpace["largest"])[0]?.["name"], join(tree, "few"));
  assert.equal(byInodes["partial"], false);
  assert.equal(typeof byInodes["filesystem"], "string");
});

test("the move destination inside the host folder is not a second root of the same filesystem, so the alarm names its bytes once", () => {
  const dir = tempDir("fleet-host-dir-");
  const moved = join(dir, "tmp-scratch", "fleet-c-7");
  mkdirSync(moved, { recursive: true });
  for (let index = 0; index < 5; index += 1) writeFileSync(join(moved, `f${String(index)}`), "x");

  const report = parseRecord(fleet(["scratch", "--json"], { FLEET_HOST_DIR: dir }).trim());
  const shared = records(report["filesystems"]).find((each) =>
    Array.isArray(each["roots"]) ? each["roots"].includes(dir) : false,
  );
  assert.ok(shared !== undefined, "the host folder is a root of a reported filesystem");
  assert.ok(Array.isArray(shared["roots"]));
  assert.ok(
    !shared["roots"].includes(join(dir, "tmp-scratch")),
    "the destination under the host folder is covered by the host folder",
  );
});
