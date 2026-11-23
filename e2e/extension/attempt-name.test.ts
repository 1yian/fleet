import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
  mateConnected as connected,
  startDispatchLab,
  stopDispatchLab,
  WORKER_WAIT_MS,
  type DispatchLab,
} from "../support/dispatch-lab.ts";
import { records } from "../support/json.ts";
import { poll, type Move, type Turn } from "../support/harness.ts";
import { tempDir } from "../support/run-root.ts";
import { DISPATCH } from "../support/scratch-files.ts";

let parts: DispatchLab;
let out: string;
beforeEach(async () => {
  out = tempDir("fleet-attempt-names-");
  parts = await startDispatchLab({ workerShell: true });
  parts.cardd.yolo("site");
});
afterEach(async (t) => {
  await parts.lab.printIfFailed(t);
  await stopDispatchLab(parts);
});

const publish = (kind: "shell" | "job"): string =>
  `printf '%s' "$FLEET_ATTEMPT" > "${out}/.$$" && mv "${out}/.$$" "${out}/${kind}-$(basename "$PWD")"`;

const woken = (turns: Turn[]): boolean =>
  turns.some((turn) => turn.role === "user" && turn.text.includes("exited 0"));

const nameOf = (turns: Turn[]): Move => {
  if (woken(turns)) return { tool: "report", args: { status: "done", text: "named" } };
  const ran = turns.filter((turn) => turn.role === "toolResult").length;
  if (ran === 0)
    return {
      tool: "bash",
      args: { command: publish("shell") },
    };
  if (ran === 1)
    return {
      tool: "run_long",
      args: {
        label: "name",
        command: publish("job"),
      },
    };
  return { text: "waiting for the job" };
};

const seen = (kind: "shell" | "job", folder: string): string | undefined => {
  const file = join(out, `${kind}-${folder}`);
  return existsSync(file) ? readFileSync(file, "utf8") : undefined;
};

const named = (...attempts: string[]): boolean =>
  attempts.every(
    (attempt) => seen("shell", attempt) !== undefined && seen("job", attempt) !== undefined,
  );

const waitUntilNamed = (...attempts: string[]): Promise<boolean> =>
  poll(
    () => (named(...attempts) ? true : undefined),
    "the workers to record their names",
    WORKER_WAIT_MS,
  );

test("two cards of one lane each run their shell and their jobs under their own attempt name", async () => {
  const { h, mate } = parts;
  h.onModel(() => ({ tool: "board", args: {} }), "mate");
  h.onModel(() => ({ tool: "dispatch", args: DISPATCH }), "mate");
  h.onModel(
    () => ({
      tool: "dispatch",
      args: { ...DISPATCH, title: "Check the checkout", name: "check-the-checkout" },
    }),
    "mate",
  );
  h.onModel(() => ({ text: "dispatched both" }), "mate");
  for (let call = 0; call < 8; call += 1) h.onModel(nameOf, "worker");
  await connected(h);
  mate.prompt("run both checks");
  await waitUntilNamed("c-1-a1", "c-2-a1");

  for (const attempt of ["c-1-a1", "c-2-a1"]) {
    assert.equal(seen("shell", attempt), attempt, `the shell of ${attempt}`);
    assert.equal(seen("job", attempt), attempt, `a run_long job of ${attempt}`);
  }
});

test("a worker started in a workspace that already exists still runs under its attempt name", async () => {
  const { h, mate, lab, clone } = parts;
  const path = `${clone}.worktrees/c-1-a1`;
  h.onModel(() => ({ tool: "board", args: {} }), "mate");
  let created: unknown;
  h.onModel(async () => {
    execFileSync("git", ["-C", clone, "worktree", "add", "-b", "c-1-a1", path, "main"], {
      stdio: "ignore",
    });
    const made = await lab.run([
      "workspace",
      "create",
      "--cwd",
      path,
      "--label",
      "run-the-tests",
      "--no-focus",
    ]);
    created = records([made["workspace"]])[0]?.["workspace_id"];
    return { tool: "dispatch", args: DISPATCH };
  }, "mate");
  h.onModel(() => ({ text: "dispatched" }), "mate");
  for (let call = 0; call < 4; call += 1) h.onModel(nameOf, "worker");
  await connected(h);
  mate.prompt("run the checks");
  await waitUntilNamed("c-1-a1");

  assert.equal(typeof created, "string", "the fixture workspace id");
  const workspaces = records((await lab.run(["workspace", "list"]))["workspaces"]).filter(
    (each) => String(each["label"]).includes("run-the-tests"),
  );
  assert.deepEqual(
    workspaces.map((each) => each["workspace_id"]),
    [created],
    "the worker ran in the pre-created workspace, with no second one opened",
  );
  assert.equal(seen("shell", "c-1-a1"), "c-1-a1", "the shell of the reused workspace");
  assert.equal(seen("job", "c-1-a1"), "c-1-a1", "a run_long job of the reused workspace");
});
