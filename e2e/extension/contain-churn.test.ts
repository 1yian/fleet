import assert from "node:assert/strict";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
  mateConnected,
  startDispatchLab,
  stopDispatchLab,
  toolResults,
  WORKER_WAIT_MS,
  type DispatchLab,
} from "../support/dispatch-lab.ts";
import { tempDir } from "../support/run-root.ts";

const churningShell = (real: string): string => `#!/bin/sh
(
  i=0
  while [ "$i" -lt 400 ]; do
    sleep 0.05 &
    sleep 0.01
    i=$((i + 1))
  done
) &
exec '${real}' "$@"
`;

let parts: DispatchLab;
let before: string | undefined;
beforeEach(async () => {
  const shell = join(tempDir("fleet-churn-"), "shell");
  writeFileSync(shell, churningShell(process.env["SHELL"] ?? "/bin/sh"));
  chmodSync(shell, 0o755);
  before = process.env["SHELL"];
  process.env["SHELL"] = shell;
  parts = await startDispatchLab();
});
afterEach(async () => {
  if (before === undefined) Reflect.deleteProperty(process.env, "SHELL");
  else process.env["SHELL"] = before;
  await stopDispatchLab(parts);
});

test("dispatch contains a worker whose pane shell keeps starting and ending child processes", async () => {
  const { h, mate } = parts;
  h.onModel(() => ({ tool: "board", args: {} }), "mate");
  h.onModel(
    () => ({
      tool: "dispatch",
      args: {
        title: "Fix the scrollbar",
        name: "scrollbar",
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
  h.onModel(() => ({ text: "working" }), "worker");
  await mateConnected(h);
  mate.prompt("fix the scrollbar");

  const results = toolResults(await h.waitForCall(2, "mate", WORKER_WAIT_MS));
  assert.equal(results.at(-1), "Dispatched c-1-a1 on local, branch c-1-a1.");
});
