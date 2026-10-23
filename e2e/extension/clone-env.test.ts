import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  branchesOf,
  mateConnected,
  startDispatchLab,
  stopDispatchLab,
  toolResults,
  WORKER_WAIT_MS,
  type DispatchLab,
} from "../support/dispatch-lab.ts";
import { landOnRemote, tip } from "../support/remote.ts";

let parts: DispatchLab;
afterEach(async (t) => {
  await parts.lab.printIfFailed(t);
  await stopDispatchLab(parts);
});

function scriptDispatch(): void {
  const { h } = parts;
  h.onModel(() => ({ tool: "board", args: {} }), "mate");
  h.onModel(
    () => ({
      tool: "dispatch",
      args: {
        title: "Add credit",
        name: "add-credit",
        kind: "ship",
        project: "site",
        intent: "Fix the scrollbar",
        host: "local",
        task: "add the credit",
      },
    }),
    "mate",
  );
  h.onModel(() => ({ text: "done" }), "mate");
}

async function dispatchResult(): Promise<string> {
  await mateConnected(parts.h);
  parts.mate.prompt("add credit");
  return toolResults(await parts.h.waitForCall(2, "mate", WORKER_WAIT_MS)).at(-1) ?? "";
}

test("dispatch fetches a remote that only the clone's .envrc makes reachable", async () => {
  parts = await startDispatchLab({ remote: true, gate: "allowed" });
  const fresh = landOnRemote(parts.remote ?? "", "merged-elsewhere");
  scriptDispatch();
  const result = await dispatchResult();

  assert.match(result, /^Dispatched c-1-a1 on local, branch c-1-a1\.$/);
  assert.equal(tip(`${parts.clone}.worktrees/c-1-a1`, "HEAD"), fresh);
  assert.deepEqual(branchesOf(parts.clone), ["c-1-a1", "main"]);
});

test("dispatch names a blocked .envrc instead of a bare fetch failure", async () => {
  parts = await startDispatchLab({ remote: true, gate: "blocked" });
  scriptDispatch();
  const result = await dispatchResult();

  assert.match(
    result,
    /could not fetch origin in .*\/site, so the worker would start from a stale base/,
  );
  assert.match(
    result,
    /direnv blocks the \.envrc that applies to .*\/site, run: direnv allow .*\/site/,
  );
  assert.deepEqual(branchesOf(parts.clone), ["main"]);
});

test("close refreshes a clone whose remote only the .envrc makes reachable", async () => {
  parts = await startDispatchLab({ remote: true, gate: "allowed" });
  const { h } = parts;
  const stale = tip(parts.clone);
  h.onModel(() => ({ tool: "board", args: {} }), "mate");
  h.onModel(
    () => ({
      tool: "dispatch",
      args: {
        title: "Add credit",
        name: "add-credit",
        kind: "ship",
        project: "site",
        intent: "Fix the scrollbar",
        host: "local",
        task: "add the credit",
      },
    }),
    "mate",
  );
  h.onModel(() => ({ text: "dispatched" }), "mate");
  let fresh = "";
  h.onModel(() => {
    fresh = landOnRemote(parts.remote ?? "", "merged-pr");
    return { tool: "report", args: { status: "done", text: "credit added" } };
  }, "worker");
  h.onModel(() => ({ tool: "close", args: { card: 1, summary: "Added $10." } }), "mate");
  h.onModel(() => ({ text: "closed" }), "mate");
  await mateConnected(h);
  parts.mate.prompt("add credit");
  const result = toolResults(await h.waitForCall(4, "mate", WORKER_WAIT_MS)).at(-1) ?? "";

  assert.equal(
    result,
    `c-1 is done. Clones: site on local: synced ${stale.slice(0, 7)}..${fresh.slice(0, 7)}.`,
  );
  assert.equal(tip(parts.clone), fresh);
});
