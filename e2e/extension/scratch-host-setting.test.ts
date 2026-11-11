import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import {
  mateConnected as connected,
  startDispatchLab,
  stopDispatchLab,
  toolResults,
  WORKER_WAIT_MS,
  type DispatchLab,
} from "../support/dispatch-lab.ts";
import { parseRecord } from "../support/json.ts";
import { tempDir } from "../support/run-root.ts";
import {
  DISPATCH,
  fleet,
  fleetResult,
  listing,
  setHostSettings,
} from "../support/scratch-files.ts";

const SHELL = fileURLToPath(new URL("../support/shell-tool.ts", import.meta.url));
const LOGIN = fileURLToPath(new URL("../support/login-transport.ts", import.meta.url));
const CHECKOUT = fileURLToPath(new URL("../..", import.meta.url));
const SEEDED = ["notes/", "notes/log.txt", "report.md"];

let parts: DispatchLab;
let mateHost: string;
let farHost: string;
let farTmp: string;
let mateTmp: string;
let old: string;

const mateHostDir = (): string => join(mateHost, ".fleet");
const farHostDir = (): string => join(farHost, ".fleet");
const farLogin = (): Record<string, string> => ({ HOME: farHost, FLEET_HOST_DIR: "" });

beforeEach(async () => {
  mateHost = tempDir("fleet-mate-host-");
  farHost = tempDir("fleet-far-host-");
  farTmp = tempDir("fleet-far-tmp-");
  mateTmp = tempDir("fleet-mate-tmp-");
  old = join(farTmp, "fleet-c-1");
  mkdirSync(join(old, "notes"), { recursive: true });
  writeFileSync(join(old, "report.md"), "the evidence of card 1\n");
  writeFileSync(join(old, "notes", "log.txt"), "a note\n");
  mkdirSync(join(mateTmp, "fleet-c-1"));
  writeFileSync(join(mateTmp, "fleet-c-1", "other.md"), "not this card's host\n");
  const config = process.env["XDG_CONFIG_HOME"] ?? join(process.env["HOME"] ?? "", ".config");
  parts = await startDispatchLab({
    workerArgs: ["-e", SHELL],
    mate: {
      HOME: mateHost,
      FLEET_HOST_DIR: "",
      FLEET_TMP_SOURCE_DIR: mateTmp,
      XDG_CONFIG_HOME: config,
    },
    hosts: { p620: ["node", LOGIN, farHost, farTmp] },
    roots: { p620: CHECKOUT },
  });
  parts.cardd.yolo("site");
});

afterEach(async () => {
  await stopDispatchLab(parts);
});

async function closeCardOnFarHost(): Promise<string> {
  const { h, mate } = parts;
  h.onModel(() => ({ tool: "board", args: {} }), "mate");
  h.onModel(() => ({ tool: "dispatch", args: { ...DISPATCH, host: "p620" } }), "mate");
  h.onModel(() => ({ text: "dispatched" }), "mate");
  h.onModel(() => ({ tool: "report", args: { status: "done", text: "ran them" } }), "worker");
  h.onModel(() => ({ tool: "close", args: { card: 1, summary: "Done." } }), "mate");
  await connected(h);
  mate.prompt("run the tests");
  return toolResults(await h.waitForCall(4, "mate", WORKER_WAIT_MS)).at(-1) ?? "";
}

test("a close from another host moves the card's /tmp scratch to the folder that the far host's own settings name, whatever the closing mate's host says", async () => {
  const disk = join(tempDir("fleet-far-disk-"), "kept");
  const wrongRoot = tempDir("fleet-mate-disk-");
  setHostSettings(farHostDir(), { tmpScratch: disk });
  setHostSettings(mateHostDir(), { tmpScratch: join(wrongRoot, "kept") });

  const result = await closeCardOnFarHost();

  const moved = join(disk, "fleet-c-1");
  assert.equal(result, `c-1 is done. Scratch moved off /tmp: p620:${old} moved to ${moved}.`);
  assert.equal(readlinkSync(old), moved);
  assert.deepEqual(listing(old), SEEDED);
  assert.equal(readFileSync(join(moved, "report.md"), "utf8"), "the evidence of card 1\n");
  assert.deepEqual(listing(wrongRoot), [], "the closing mate's own host setting is not used");
  assert.equal(
    parseRecord(fleet(["scratch", "--json"], farLogin()).trim())["tmpScratch"],
    disk,
    "the far host's own scratch report, which the alarm reads, names the same folder",
  );
  assert.deepEqual(listing(mateTmp), ["fleet-c-1/", "fleet-c-1/other.md"]);
});

test("with nothing set on the far host, the scratch goes under that host's own fleet folder, not the closing mate's", async () => {
  const wrongRoot = tempDir("fleet-mate-disk-");
  setHostSettings(mateHostDir(), { tmpScratch: join(wrongRoot, "kept") });

  const result = await closeCardOnFarHost();

  const moved = join(farHostDir(), "tmp-scratch", "fleet-c-1");
  assert.equal(result, `c-1 is done. Scratch moved off /tmp: p620:${old} moved to ${moved}.`);
  assert.equal(readlinkSync(old), moved);
  assert.deepEqual(listing(old), SEEDED);
  assert.deepEqual(listing(wrongRoot), []);
  assert.equal(
    parseRecord(fleet(["scratch", "--json"], farLogin()).trim())["tmpScratch"],
    join(farHostDir(), "tmp-scratch"),
  );
});

test("a host's settings that cannot be used leave the folder in place and say why, and the host's scratch report refuses them by name", async () => {
  const file = setHostSettings(farHostDir(), { tmpScratch: "relative/path" });

  const result = await closeCardOnFarHost();

  assert.equal(
    result,
    `c-1 is done. Scratch left in /tmp: p620:${old} stays in place: ${file} is not usable: "tmpScratch" must be an absolute path.`,
  );
  assert.deepEqual(listing(old), SEEDED);
  assert.equal(existsSync(join(farHostDir(), "tmp-scratch")), false);
  const report = fleetResult(["scratch", "--json"], farLogin());
  assert.notEqual(report.status, 0);
  assert.ok(
    report.stderr.includes(`${file} is not usable: "tmpScratch" must be an absolute path`),
    report.stderr,
  );
});
