import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";
import {
  branchesOf,
  mateConnected,
  sidebarOf,
  startDispatchLab,
  stopDispatchLab,
  toolResults,
  WORKER_WAIT_MS,
  workersOf,
  worktreesOf,
  type DispatchLab,
} from "../support/dispatch-lab.ts";

let parts: DispatchLab;
afterEach(async (t) => {
  await parts.lab.printIfFailed(t);
  await stopDispatchLab(parts);
});

const dispatchTo = (host: string) => ({
  tool: "dispatch",
  args: {
    title: "Users see one scrollbar",
    name: "one-scrollbar",
    kind: "ship",
    project: "site",
    intent: "Fix the scrollbar",
    host,
    task: "fix the scrollbar",
  },
});

async function workSnapshot() {
  const { cardd, clone, lab } = parts;
  const db = new DatabaseSync(cardd.db, { readOnly: true });
  try {
    return {
      cards: (await cardd.board()).cards.map((card) => card.id),
      attempts: db.prepare("SELECT count(*) AS n FROM attempts").get()?.["n"],
      branches: branchesOf(clone),
      worktrees: worktreesOf(clone),
      workspaces: await sidebarOf(lab),
      workers: await workersOf(lab),
    };
  } finally {
    db.close();
  }
}

test("an unsupported lane-local transport refuses without phantom work, and a corrected dispatch stays idempotent", async () => {
  parts = await startDispatchLab();
  const { h, mate, cardd, clone } = parts;
  cardd.moveClone("site", "ghost", clone);
  let rejected: Awaited<ReturnType<typeof workSnapshot>> | undefined;
  h.onModel(() => dispatchTo("ghost"), "mate");
  h.onModel(async () => {
    rejected = await workSnapshot();
    return dispatchTo("local");
  }, "mate");
  h.onModel(() => dispatchTo("local"), "mate");
  h.onModel(() => ({ text: "dispatched" }), "mate");
  h.onModel(() => ({ text: "working" }), "worker");
  await mateConnected(h);
  mate.prompt("ship the scrollbar fix");

  const results = toolResults(await h.waitForCall(3, "mate", WORKER_WAIT_MS));
  assert.equal(results.at(-3), "no transport for ghost");
  assert.deepEqual(rejected, {
    cards: [],
    attempts: 0,
    branches: ["main"],
    worktrees: ["branch refs/heads/main"],
    workspaces: [],
    workers: [],
  });
  assert.equal(results.at(-2), "Dispatched c-1-a1 on local, branch c-1-a1.");
  assert.match(results.at(-1) ?? "", /already (running|starting)/);
  const started = await workSnapshot();
  assert.deepEqual(started.cards, [1]);
  assert.equal(started.attempts, 1);
  assert.deepEqual(started.workers, ["c-1-a1"]);
});

test("a supported but unreachable transport keeps the failed work visible rather than deleting its card", async () => {
  parts = await startDispatchLab();
  const { h, mate, cardd } = parts;
  writeFileSync(join(h.dir, "far-down"), "down\n");
  h.onModel(() => dispatchTo("far"), "mate");
  h.onModel(() => ({ text: "host failed" }), "mate");
  await mateConnected(h);
  mate.prompt("ship the scrollbar fix");

  const result = toolResults(await h.waitForCall(1, "mate", WORKER_WAIT_MS)).at(-1) ?? "";
  assert.match(result, /on far/);
  assert.match(result, /Operation timed out/);
  assert.doesNotMatch(result, /no transport/);
  assert.deepEqual(
    (await cardd.board()).cards.map((card) => ({ id: card.id, name: card.name })),
    [{ id: 1, name: "one-scrollbar" }],
  );
  const failed = await workSnapshot();
  assert.equal(failed.attempts, 0);
  assert.deepEqual(failed.branches, ["main"]);
  assert.deepEqual(failed.workspaces, []);
});

test("a valid transport that loses its connection after attempt creation preserves the failed attempt", async () => {
  parts = await startDispatchLab({
    hosts: {
      broken: [
        "sh",
        "-c",
        'case "$1" in *herdr*) echo "ssh: connection lost" >&2; exit 255;; *) exec sh -c "$1";; esac',
        "transport",
      ],
    },
    roots: { broken: fileURLToPath(new URL("../..", import.meta.url)) },
  });
  const { h, mate, cardd } = parts;
  h.onModel(() => dispatchTo("broken"), "mate");
  h.onModel(() => ({ text: "host failed" }), "mate");
  await mateConnected(h);
  mate.prompt("ship the scrollbar fix");

  const result = toolResults(await h.waitForCall(1, "mate", WORKER_WAIT_MS)).at(-1) ?? "";
  assert.match(result, /on broken failed: ssh: connection lost/);
  assert.doesNotMatch(result, /fleet-token/);
  const failed = await workSnapshot();
  assert.deepEqual(failed.cards, [1]);
  assert.equal(failed.attempts, 1);
  assert.deepEqual(failed.branches, ["main"]);
  assert.deepEqual(failed.workspaces, []);
  assert.deepEqual(failed.workers, []);
  const thread = await cardd.thread(1);
  assert.ok(thread.entries.some((entry) => entry.body.includes("fix the scrollbar")));
});
