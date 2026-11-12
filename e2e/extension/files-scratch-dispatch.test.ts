import assert from "node:assert/strict";
import { chmodSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
  mateConnected,
  startDispatchLab,
  stopDispatchLab,
  WORKER_WAIT_MS,
  workersOf,
  worktreesOf,
  type DispatchLab,
} from "../support/dispatch-lab.ts";
import { git } from "../support/remote.ts";
import { tempDir } from "../support/run-root.ts";
import { Scratch } from "../support/scratch.ts";

let parts: DispatchLab;
let fleetHome: Scratch;
beforeEach(async () => {
  parts = await startDispatchLab({ remote: true });
  fleetHome = new Scratch();
});
afterEach(async (t) => {
  await parts.lab.printIfFailed(t);
  fleetHome.dispose();
  await stopDispatchLab(parts);
});

test("a dispatched worker still starts, beside a scratch worktree of the same clone", async () => {
  const { cardd, clone, h, lab, mate, home } = parts;
  writeFileSync(join(clone, "README"), "site\n");
  git(clone, "add", "README");
  git(clone, "commit", "-q", "-m", "readme");
  git(clone, "push", "-q", "origin", "main");
  const bin = tempDir("files-bin-");
  writeFileSync(join(bin, "nvim"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(bin, "nvim"), 0o755);
  const laneHome = fleetHome.addLane("tree", {
    url: cardd.url,
    token: cardd.addLane("tree", "main"),
    host: "local",
  });
  const edited = fleetHome.fleet(["files", "edit", join(clone, "README")], {
    FLEET_FILES_HOME: laneHome,
    PATH: [bin, process.env["PATH"] ?? ""].join(delimiter),
  });
  assert.match(edited, /creating the scratch worktree of site: .*site\.worktrees\/scratch/);
  h.onModel(() => ({ tool: "board", args: {} }), "mate");
  h.onModel(
    () => ({
      tool: "dispatch",
      args: {
        title: "Users see one scrollbar",
        name: "one-scrollbar",
        kind: "ship",
        project: "site",
        intent: "Fix the scrollbar",
        host: "local",
        task: "fix the scrollbar",
      },
    }),
    "mate",
  );
  h.onModel(() => ({ text: "dispatched" }), "mate");
  h.onModel(
    () => ({
      tool: "report",
      args: { status: "done", text: "PR green", pr: "https://github.com/acme/site/pull/1" },
    }),
    "worker",
  );
  for (const label of ["1stmate", "2ndmate-cleo"])
    await lab.run(["workspace", "create", "--cwd", home, "--label", label, "--no-focus"]);
  await mateConnected(h);
  mate.prompt("ship the scrollbar fix");
  await h.waitForCall(3, "mate", WORKER_WAIT_MS);
  const trees = worktreesOf(clone);
  assert.equal(trees.length, 3);
  assert.ok(trees.includes("branch refs/heads/main"));
  assert.ok(trees.includes("branch refs/heads/c-2-a1"));
  assert.ok(trees.some((tree) => tree.startsWith("branch refs/heads/scratch/local-")));
  assert.deepEqual(await workersOf(lab), ["c-2-a1"]);
});
