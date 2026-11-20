import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { afterEach, test } from "node:test";
import {
  lastUser,
  mateConnected,
  startDispatchLab,
  stopDispatchLab,
  toolResults,
  WORKER_WAIT_MS,
  worktreesOf,
  type DispatchLab,
} from "../support/dispatch-lab.ts";

let parts: DispatchLab;
afterEach(async (t) => {
  await parts.lab.printIfFailed(t);
  await stopDispatchLab(parts);
});

const dispatchUnder = (project: string) => ({
  tool: "dispatch",
  args: {
    title: "Scratch gameplay demo video",
    name: "gameplay-demo",
    kind: "ship",
    project,
    intent: "Make me a gameplay demo video of my Scratch game",
    host: "local",
    task: "Record the demo, then play the video back and check it before you report done",
  },
});

test("on a fresh install with no registered project, dispatch refuses an unregistered project by name and starts the work under personal", async () => {
  parts = await startDispatchLab({ freshInstall: true });
  const { h, mate, cardd, clone } = parts;
  assert.equal(cardd.admin("project", "list").stdout, "");

  h.onModel(() => ({ tool: "board", args: {} }), "mate");
  h.onModel(() => dispatchUnder("fleet"), "mate");
  h.onModel(() => dispatchUnder("personal"), "mate");
  h.onModel(() => ({ text: "dispatched" }), "mate");
  h.onModel(
    () => ({ tool: "report", args: { status: "done", text: "video played back and checked" } }),
    "worker",
  );
  await mateConnected(h);
  mate.prompt("make a gameplay demo video of my Scratch game");

  const woken = await h.waitForCall(4, "mate", WORKER_WAIT_MS);
  const results = toolResults(woken);
  assert.match(results[0] ?? "", /^projects: 0 registered$/m);
  assert.match(
    results[1] ?? "",
    /project fleet is not registered, so nothing was created\..*project "personal", which dispatch makes on first use\. Never do the work yourself/,
  );
  assert.equal(results[2], "Dispatched c-1-a1 on local, branch c-1-a1.");

  const workerFirst = await h.waitForCall(0, "worker");
  assert.equal(
    lastUser(workerFirst),
    "[fleet] main on c-1 gameplay-demo: Record the demo, then play the video back and check it before you report done\n\nDelivery: local-only",
  );
  assert.match(
    lastUser(woken) ?? "",
    /^\[fleet\] c-1 gameplay-demo done: video played back and checked/,
  );

  assert.equal(
    cardd.admin("project", "list").stdout,
    `personal: local-only, yolo off, repo not set, local=${clone}`,
  );
  assert.deepEqual(
    (await cardd.board()).cards.map((card) => [card.id, card.project, card.kind]),
    [[1, "personal", "ship"]],
  );
  assert.deepEqual(worktreesOf(clone), ["branch refs/heads/main", "branch refs/heads/c-1-a1"]);
  assert.equal(
    execFileSync("git", ["-C", clone, "log", "main", "--format=%s"], { encoding: "utf8" }).trim(),
    "Start the personal project",
  );
});
