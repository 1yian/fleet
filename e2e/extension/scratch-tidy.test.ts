import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parseRecord } from "../support/json.ts";
import { tempDir } from "../support/run-root.ts";
import {
  backdate,
  closedFoldersOf,
  epochDaysAgo,
  fleet,
  fleetAsync,
  listing,
  nameOf,
  scratchOf,
  seedClosed,
  seedOpen,
  tidyByHand,
} from "../support/scratch-files.ts";

test("tidy removes only closed folders that are a week old by their own name: an open card is never touched however old, a younger closed folder stays, links are never followed, and old compile cache entries go", () => {
  const dir = tempDir("fleet-host-dir-");
  const open = seedOpen(dir, 2, 90);
  const young = seedClosed(dir, 3, 1);
  const old = seedClosed(dir, 4, 8);
  const older = seedClosed(dir, 4, 9, "evidence", "-1");
  const strangers = [join(scratchOf(dir), "notes"), join(scratchOf(dir), "c-6.closed-soon")];
  for (const stranger of strangers) {
    mkdirSync(stranger, { recursive: true });
    writeFileSync(join(stranger, "keep.txt"), "not a closed card folder");
    backdate(join(stranger, "keep.txt"), 90);
  }
  const outside = tempDir("fleet-outside-");
  mkdirSync(join(outside, "tmp"));
  writeFileSync(join(outside, "precious.txt"), "outside the scratch root");
  const linked = `c-5.closed-${String(epochDaysAgo(90))}`;
  symlinkSync(outside, join(scratchOf(dir), linked));
  const leftover = join(scratchOf(dir), ".removing-4242-abc");
  mkdirSync(join(leftover, "deps"), { recursive: true });
  writeFileSync(join(leftover, "deps", "index.js"), "x");
  symlinkSync(outside, join(scratchOf(dir), ".removing-4242-link"));
  const cache = join(dir, "node-compile-cache", "v24.0.0-x64-aaaa-1000");
  mkdirSync(cache, { recursive: true });
  writeFileSync(join(cache, "fresh"), "entry");
  writeFileSync(join(cache, "stale"), "entry");
  backdate(join(cache, "stale"), 3);
  const before = listing(open);

  assert.deepEqual(tidyByHand(dir)["tidied"], { cacheFiles: 1, cards: ["c-4"] });

  assert.deepEqual(listing(open), before);
  assert.equal(existsSync(old), false);
  assert.equal(existsSync(older), false);
  assert.deepEqual(listing(young), ["report.md"]);
  assert.deepEqual(readdirSync(scratchOf(dir)).sort(), [
    ".removing-4242-link",
    "c-2",
    nameOf(young),
    linked,
    "c-6.closed-soon",
    "notes",
  ]);
  assert.equal(existsSync(leftover), false);
  for (const stranger of strangers)
    assert.equal(readFileSync(join(stranger, "keep.txt"), "utf8"), "not a closed card folder");
  assert.deepEqual(listing(outside), ["precious.txt", "tmp/"]);
  assert.deepEqual(readdirSync(cache), ["fresh"]);

  assert.deepEqual(tidyByHand(dir)["tidied"], { cacheFiles: 0, cards: [] });
});

test("tidy with no fleet folder yet does nothing and succeeds, at the default place under the home folder", () => {
  const empty = tempDir("fleet-empty-home-");
  const out = parseRecord(
    fleet(["scratch", "--tidy", "--json"], { HOME: empty, FLEET_HOST_DIR: "" })
      .trim()
      .split("\n")
      .at(-1) ?? "",
  );
  assert.deepEqual(out["tidied"], { cacheFiles: 0, cards: [] });
  const cache = join(empty, ".fleet", "node-compile-cache");
  mkdirSync(cache, { recursive: true });
  writeFileSync(join(cache, "stale"), "entry");
  backdate(join(cache, "stale"), 3);
  const next = parseRecord(
    fleet(["scratch", "--tidy", "--json"], { HOME: empty, FLEET_HOST_DIR: "" })
      .trim()
      .split("\n")
      .at(-1) ?? "",
  );
  assert.deepEqual(next["tidied"], { cacheFiles: 1, cards: [] });
});

const ROUNDS = 5;
const RUNNERS = 4;

test("tidies and reopens that run together over one card's old closed folder never take a live folder: every reopen ends with its temp folder, nothing is nested, and no folder is left half removed", async () => {
  const dir = tempDir("fleet-host-dir-");
  const card = join(scratchOf(dir), "c-9");
  const env = { FLEET_HOST_DIR: dir };
  for (let round = 0; round < ROUNDS; round += 1) {
    rmSync(card, { recursive: true, force: true });
    seedClosed(dir, 9, 8, `evidence ${String(round)}`);
    const reopen = async (): Promise<void> => {
      const out = await fleetAsync(["scratch", "--open", "9"], env);
      assert.equal(out.split("\n")[0], card);
      assert.equal(existsSync(join(card, "tmp")), true, "a reopen ends with its temp folder");
    };
    const tidies = Array.from({ length: RUNNERS }, () =>
      fleetAsync(["scratch", "--tidy", "--json"], env),
    );
    const opens = Array.from({ length: RUNNERS }, reopen);
    await Promise.all([...tidies, ...opens]);

    assert.equal(existsSync(join(card, "tmp")), true, "no tidy took the temp folder away");
    assert.deepEqual(
      readdirSync(card).filter((name) => name.startsWith("c-9")),
      [],
      "no closed folder was moved into the card's folder",
    );
  }
  fleet(["scratch", "--tidy", "--json"], env);
  assert.deepEqual(
    readdirSync(scratchOf(dir)).filter((name) => name.startsWith(".removing-")),
    [],
  );
  assert.equal(existsSync(join(card, "tmp")), true);
  const kept = readdirSync(scratchOf(dir)).sort();
  assert.deepEqual(kept, ["c-9"]);
});

test("a reopen of a card whose folder is open leaves its evidence and its closed twin alone, and never nests one in the other", () => {
  const dir = tempDir("fleet-host-dir-");
  const live = seedOpen(dir, 3, 1);
  const twin = seedClosed(dir, 3, 2, "a closed twin");
  const out = fleet(["scratch", "--open", "3"], { FLEET_HOST_DIR: dir });

  assert.equal(out.split("\n")[0], live);
  assert.deepEqual(listing(live), ["report.md", "tmp/", "tmp/deps/", "tmp/deps/index.js"]);
  assert.equal(readFileSync(join(live, "report.md"), "utf8"), "evidence");
  assert.equal(readFileSync(join(twin, "report.md"), "utf8"), "a closed twin");
  assert.deepEqual(closedFoldersOf(dir, 3), [nameOf(twin)]);
});

test("a reopen takes the latest closed folder of its card, by the time and then the number in its name, and no other card's", () => {
  const dir = tempDir("fleet-host-dir-");
  const stamp = epochDaysAgo(2);
  const name = (card: number, suffix: string): string => `c-${String(card)}.closed-${suffix}`;
  const folders = [
    name(3, String(stamp - 500)),
    name(3, `${String(stamp)}-9`),
    name(3, `${String(stamp)}-10`),
    name(3, `${String(stamp - 1)}-99`),
    name(30, String(stamp + 1000)),
  ];
  for (const folder of folders) {
    mkdirSync(join(scratchOf(dir), folder), { recursive: true });
    writeFileSync(join(scratchOf(dir), folder, "report.md"), folder);
  }

  const out = fleet(["scratch", "--open", "3"], { FLEET_HOST_DIR: dir });

  const live = join(scratchOf(dir), "c-3");
  assert.equal(out.split("\n")[0], live);
  assert.equal(readFileSync(join(live, "report.md"), "utf8"), name(3, `${String(stamp)}-10`));
  assert.equal(existsSync(join(live, "tmp")), true);
  assert.deepEqual(readdirSync(scratchOf(dir)).sort(), [
    "c-3",
    name(3, String(stamp - 500)),
    name(3, `${String(stamp - 1)}-99`),
    name(3, `${String(stamp)}-9`),
    name(30, String(stamp + 1000)),
  ]);
});
