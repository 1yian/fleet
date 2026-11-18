import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { check, OPS } from "@fleet/protocol";
import {
  mateConnected,
  startDispatchLab,
  stopDispatchLab,
  toolResults,
  WORKER_WAIT_MS,
  workersOf,
  type DispatchLab,
} from "../support/dispatch-lab.ts";
import { landOnRemote, tip } from "../support/remote.ts";
import { tempDir } from "../support/run-root.ts";
import { DISPATCH, tidyByHand } from "../support/scratch-files.ts";

let lab: DispatchLab;
let host: string;
let tmp: string;
const DAY_MS = 86_400_000;
const NINE_DAYS = 9 * DAY_MS;

beforeEach(async () => {
  host = tempDir("card-scratch-host-");
  tmp = tempDir("card-scratch-tmp-");
  const clock = encodeURIComponent(
    `const now = Date.now; Date.now = () => now() - ${String(NINE_DAYS)};`,
  );
  lab = await startDispatchLab({
    cardd: { NODE_OPTIONS: `--import=data:text/javascript,${clock}` },
    mate: { FLEET_HOST_DIR: host, FLEET_TMP_SOURCE_DIR: tmp },
    remote: true,
  });
  lab.cardd.yolo("site");
});

afterEach(async () => {
  if (lab !== undefined) await stopDispatchLab(lab);
});

function evidenceAt(id: number) {
  const card = `c-${String(id)}`;
  const source = join(host, "scratch", card);
  const legacy = join(tmp, `fleet-${card}`);
  const files = [
    [join(source, "report.md"), "findings only on the worker host\n"],
    [join(source, "tmp", "media.mp4"), "original temp media\n"],
    [join(legacy, "legacy.md"), "unmigrated evidence\n"],
  ] as const;
  return {
    seed() {
      mkdirSync(join(source, "tmp"), { recursive: true });
      mkdirSync(legacy);
      const aged = new Date(Date.now() - NINE_DAYS);
      for (const [path, bytes] of files) {
        writeFileSync(path, bytes);
        utimesSync(path, aged, aged);
      }
      for (const folder of [source, join(source, "tmp"), legacy]) utimesSync(folder, aged, aged);
    },
    assertPreserved() {
      assert.equal(lstatSync(source).isDirectory(), true);
      assert.equal(lstatSync(legacy).isDirectory(), true);
      for (const [path, bytes] of files) assert.equal(readFileSync(path, "utf8"), bytes, path);
    },
    assertNotIn(result: string) {
      for (const [path, bytes] of files) {
        assert.ok(!result.includes(path));
        assert.ok(!result.includes(bytes.trim()));
      }
    },
  };
}

async function assertClose(id: number, status: "done" | "dropped", summary: string) {
  const thread = await lab.cardd.thread(id);
  assert.equal(thread.card.status, status);
  const closed = thread.entries.find((entry) => entry.kind === "cleanup");
  assert.ok(closed);
  assert.equal(closed.body, summary);
  assert.ok(Date.now() - closed.createdAt > 7 * DAY_MS);
}

function tidyAgedScratch(): void {
  const root = join(host, "node-compile-cache");
  mkdirSync(root, { recursive: true });
  const cache = join(root, "old-entry");
  writeFileSync(cache, "old cache bytes");
  const aged = new Date(Date.now() - 30 * DAY_MS);
  utimesSync(cache, aged, aged);
  assert.deepEqual(tidyByHand(host)["tidied"], { cacheFiles: 1, cards: [] });
  assert.equal(existsSync(cache), false);
}

test("owner close refreshes the clone and preserves aged evidence without publishing it", async () => {
  const { h, mate, remote, clone, home } = lab;
  assert.ok(remote);
  const evidence = evidenceAt(1);
  let refreshed = "";
  h.onModel(() => ({ tool: "board", args: {} }), "mate");
  h.onModel(() => ({ tool: "dispatch", args: DISPATCH }), "mate");
  h.onModel(() => ({ text: "dispatched" }), "mate");
  h.onModel(() => {
    assert.equal(lstatSync(join(host, "scratch/c-1/tmp")).isDirectory(), true);
    evidence.seed();
    refreshed = landOnRemote(remote, "refresh-after-dispatch");
    return { tool: "report", args: { status: "done", text: "Finished the work" } };
  }, "worker");
  h.onModel(
    () => ({ tool: "close", args: { card: 1, summary: "Findings reviewed", confirm: true } }),
    "mate",
  );
  await mateConnected(h);
  mate.prompt("Close the reviewed card.");
  const result = toolResults(await h.waitForCall(4, "mate", WORKER_WAIT_MS)).at(-1) ?? "";
  assert.match(result, /^c-1 is done\./);
  evidence.assertNotIn(result);
  assert.equal(tip(clone), refreshed);
  assert.deepEqual(await workersOf(lab.lab), []);
  await assertClose(1, "done", "Findings reviewed");
  evidence.assertPreserved();
  tidyAgedScratch();
  evidence.assertPreserved();
  assert.equal(existsSync(join(home, "data/reports")), false);
});

test("parent close drops a child card without publishing or disturbing its evidence", async () => {
  const { cardd, h, mate, home } = lab;
  const childHome = tempDir("child-lane-home-");
  const owner = await cardd.connect(cardd.addLane("cleo", "main", childHome));
  try {
    const { id } = check(
      OPS["card.new"].result,
      await owner.call("card.new", { title: "Child evidence", kind: "ship", project: "site" }),
    );
    check(
      OPS["attempt.begin"].result,
      await owner.call("attempt.begin", { card: id, host: "local", task: "Write findings" }),
    );
    const evidence = evidenceAt(id);
    evidence.seed();
    h.onModel(
      () => ({ tool: "close", args: { card: id, summary: "No further work", landed: false } }),
      "mate",
    );
    await mateConnected(h);
    mate.prompt("Close the child card without landing it.");
    const result = toolResults(await h.waitForCall(1, "mate", WORKER_WAIT_MS)).at(-1) ?? "";
    assert.match(result, new RegExp(`^c-${String(id)} is dropped\\.`));
    evidence.assertNotIn(result);
    await assertClose(id, "dropped", "No further work");
    evidence.assertPreserved();
    tidyAgedScratch();
    evidence.assertPreserved();
    for (const lane of [home, childHome]) assert.equal(existsSync(join(lane, "data/reports")), false);
  } finally {
    await owner.close();
  }
});
