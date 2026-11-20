import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { hostname } from "node:os";
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

const own = hostname().split(".")[0]?.toLowerCase() ?? "";

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
    () => ({ tool: "close", args: { card: 1, summary: "Demo video checked and delivered." } }),
    "mate",
  );
  h.onModel(() => ({ text: "closed" }), "mate");
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
  assert.equal(results[2], `Dispatched c-1-a1 on ${own}, branch c-1-a1.`);

  const workerFirst = await h.waitForCall(0, "worker");
  assert.equal(
    lastUser(workerFirst),
    "[fleet] main on c-1 gameplay-demo: Record the demo, then play the video back and check it before you report done\n\nDelivery: local-only",
  );
  assert.equal(
    lastUser(woken),
    "[fleet] c-1 gameplay-demo done: video played back and checked (local-only: the branch is empty, so nothing lands) (card now with-mate)",
  );
  assert.deepEqual((await cardd.board()).holds, []);
  const closed = await h.waitForCall(5, "mate", WORKER_WAIT_MS);
  assert.equal(toolResults(closed).at(-1), "c-1 is done.");

  assert.equal(
    cardd.admin("project", "list").stdout,
    `personal: local-only, yolo off, repo not set, ${own}=${clone}`,
  );
  assert.deepEqual(
    (await cardd.board()).cards.map((card) => [card.id, card.project, card.kind]),
    [[1, "personal", "ship"]],
  );
  assert.deepEqual(worktreesOf(clone), ["branch refs/heads/main"]);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", clone, ...args], { encoding: "utf8" }).trim();
  assert.equal(git("rev-list", "--count", "main"), "1");
  assert.equal(git("rev-list", "--max-parents=0", "main"), git("rev-parse", "main"));
  assert.equal(git("ls-tree", "-r", "main"), "");
});
