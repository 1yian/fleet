import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parseRecord } from "../support/json.ts";
import { tempDir } from "../support/run-root.ts";
import {
  backdate,
  fleet,
  fleetAsync,
  listing,
  nameOf,
  scratchOf,
  seedClosed,
  seedOpen,
  tidyByHand,
} from "../support/scratch-files.ts";

test("CLI tidy prunes only old compile cache entries, leaving active cards, legacy closed paths, unknown folders, and symlink targets untouched", () => {
  const dir = tempDir("fleet-host-dir-");
  const open = seedOpen(dir, 2, 90);
  const closed = seedClosed(dir, 4, 90);
  const outside = tempDir("fleet-outside-");
  writeFileSync(join(outside, "precious.txt"), "outside the scratch root");
  symlinkSync(outside, join(scratchOf(dir), "c-5.closed-1"));
  const unknown = join(scratchOf(dir), ".removing-4242-abc");
  mkdirSync(unknown);
  writeFileSync(join(unknown, "report.md"), "an unmigrated path");
  const cache = join(dir, "node-compile-cache", "v24.0.0-x64-aaaa-1000");
  mkdirSync(cache, { recursive: true });
  writeFileSync(join(cache, "fresh"), "entry");
  writeFileSync(join(cache, "stale"), "entry");
  backdate(join(cache, "stale"), 3);
  const before = listing(open);
  const legacy = listing(closed);
  assert.deepEqual(tidyByHand(dir)["tidied"], { cacheFiles: 1, cards: [] });
  assert.deepEqual(listing(open), before);
  assert.deepEqual(listing(closed), legacy);
  assert.equal(readFileSync(join(unknown, "report.md"), "utf8"), "an unmigrated path");
  assert.equal(readFileSync(join(outside, "precious.txt"), "utf8"), "outside the scratch root");
  assert.deepEqual(readdirSync(cache), ["fresh"]);
  assert.deepEqual(tidyByHand(dir)["tidied"], { cacheFiles: 0, cards: [] });
});

test("tidy works at the default place under an isolated home and has nothing to remove until cache entries age", () => {
  const empty = tempDir("fleet-empty-home-");
  const report = (): Record<string, unknown> =>
    parseRecord(
      fleet(["scratch", "--tidy", "--json"], { HOME: empty, FLEET_HOST_DIR: "" })
        .trim()
        .split("\n")
        .at(-1) ?? "",
    );
  assert.deepEqual(report()["tidied"], { cacheFiles: 0, cards: [] });
  const cache = join(empty, ".fleet", "node-compile-cache");
  mkdirSync(cache, { recursive: true });
  writeFileSync(join(cache, "stale"), "entry");
  backdate(join(cache, "stale"), 3);
  assert.deepEqual(report()["tidied"], { cacheFiles: 1, cards: [] });
});

test("concurrent opens and tidies preserve active evidence and every unmigrated legacy path", async () => {
  const dir = tempDir("fleet-host-dir-");
  const card = seedOpen(dir, 9, 90);
  const closed = seedClosed(dir, 9, 90, "legacy evidence");
  const env = { FLEET_HOST_DIR: dir };
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      await fleetAsync(["scratch", "--tidy", "--json"], env);
      const opened = await fleetAsync(["scratch", "--open", "9"], env);
      assert.equal(opened.split("\n")[0], card);
    }),
  );
  assert.equal(readFileSync(join(card, "report.md"), "utf8"), "evidence");
  assert.equal(readFileSync(join(closed, "report.md"), "utf8"), "legacy evidence");
  assert.equal(existsSync(join(card, "tmp")), true);
  assert.deepEqual(readdirSync(scratchOf(dir)).sort(), ["c-9", nameOf(closed)].sort());
});

test("opening a new card keeps legacy paths", () => {
  const dir = tempDir("fleet-host-dir-");
  const twin = seedClosed(dir, 3, 90, "legacy report");
  const out = fleet(["scratch", "--open", "3"], { FLEET_HOST_DIR: dir });
  const card = join(scratchOf(dir), "c-3");
  assert.equal(out.split("\n")[0], card);
  assert.deepEqual(listing(card), ["tmp/"]);
  assert.equal(readFileSync(join(twin, "report.md"), "utf8"), "legacy report");
});
