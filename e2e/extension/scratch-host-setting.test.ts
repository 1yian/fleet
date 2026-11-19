import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, test } from "node:test";
import { parseRecord } from "../support/json.ts";
import { tempDir } from "../support/run-root.ts";
import { fleet, fleetResult, listing, setHostSettings } from "../support/scratch-files.ts";

const SEEDED = ["notes/", "notes/log.txt", "report.md"];

let home: string;
let tmp: string;
let old: string;

const hostDir = (): string => join(home, ".fleet");
const hostEnv = (): Record<string, string> => ({
  HOME: home,
  FLEET_HOST_DIR: "",
  FLEET_TMP_SOURCE_DIR: tmp,
});

beforeEach(() => {
  home = tempDir("fleet-move-host-");
  tmp = tempDir("fleet-move-tmp-");
  old = join(tmp, "fleet-c-1");
  mkdirSync(join(old, "notes"), { recursive: true });
  writeFileSync(join(old, "report.md"), "the evidence of card 1\n");
  writeFileSync(join(old, "notes", "log.txt"), "a note\n");
});

const move = (): string => fleet(["scratch", "--move", "1"], hostEnv()).trim();

test("the manual move uses the destination configured in host.json", () => {
  const disk = join(tempDir("fleet-move-disk-"), "kept");
  setHostSettings(hostDir(), { tmpScratch: disk });

  const result = move();

  const moved = join(disk, "fleet-c-1");
  assert.equal(result, `${old} moved to ${moved}`);
  assert.equal(readlinkSync(old), moved);
  assert.deepEqual(listing(old), SEEDED);
  assert.equal(readFileSync(join(moved, "report.md"), "utf8"), "the evidence of card 1\n");
  assert.equal(parseRecord(fleet(["scratch", "--json"], hostEnv()).trim())["tmpScratch"], disk);
});

test("the manual move defaults to tmp-scratch under the host's fleet folder", () => {
  const result = move();

  const moved = join(hostDir(), "tmp-scratch", "fleet-c-1");
  assert.equal(result, `${old} moved to ${moved}`);
  assert.equal(readlinkSync(old), moved);
  assert.deepEqual(listing(old), SEEDED);
  assert.equal(readFileSync(join(moved, "report.md"), "utf8"), "the evidence of card 1\n");
  assert.equal(
    parseRecord(fleet(["scratch", "--json"], hostEnv()).trim())["tmpScratch"],
    join(hostDir(), "tmp-scratch"),
  );
});

test("a host's settings that cannot be used leave the folder in place and say why, and the host's scratch report refuses them by name", () => {
  const file = setHostSettings(hostDir(), { tmpScratch: "relative/path" });

  const result = move();

  assert.equal(
    result,
    `${old} stays in place: ${file} is not usable: "tmpScratch" must be an absolute path`,
  );
  assert.deepEqual(listing(old), SEEDED);
  assert.equal(existsSync(join(hostDir(), "tmp-scratch")), false);
  const report = fleetResult(["scratch", "--json"], hostEnv());
  assert.notEqual(report.status, 0);
  assert.ok(
    report.stderr.includes(`${file} is not usable: "tmpScratch" must be an absolute path`),
    report.stderr,
  );
});
