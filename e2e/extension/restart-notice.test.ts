import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";
import { check, HttpOutcomeSchema, OPS } from "@fleet/protocol";
import {
  mateConnected,
  plan,
  startDispatchLab,
  stopDispatchLab,
  toolResults,
  WORKER_WAIT_MS,
  workerGroupOf,
  workersOf,
  type DispatchLab,
} from "../support/dispatch-lab.ts";
import { poll, type Turn } from "../support/harness.ts";
import { tempDir } from "../support/run-root.ts";

const SLOW = fileURLToPath(new URL("../support/slow-transport.ts", import.meta.url));
const CHECKOUT = fileURLToPath(new URL("../..", import.meta.url));

let parts: DispatchLab;
afterEach(async (t) => {
  await parts.lab.printIfFailed(t);
  await stopDispatchLab(parts);
});

const DISPATCH = {
  tool: "dispatch",
  args: {
    title: "Users see one scrollbar",
    name: "one-scrollbar",
    kind: "ship",
    project: "site",
    intent: "Fix the scrollbar",
    host: "slow",
    task: "fix the scrollbar",
  },
} as const;
const NOTICE = "Your session was restarted on the same card and conversation.";
const JOB_RESULT = "old job released by the test";

async function waitForJobResult({ cardd, mainToken }: DispatchLab): Promise<void> {
  const deadline = Date.now() + WORKER_WAIT_MS;
  for (;;) {
    const { body } = await cardd.post(mainToken, "card", { card: 1 });
    const result = check(HttpOutcomeSchema, body);
    assert.ok(result.ok, "the mate can read the card");
    const thread = check(OPS.card.result, result.value);
    if (
      thread.entries.some(
        (entry) =>
          entry.kind === "job-result" &&
          entry.fields["exitCode"] === 130 &&
          entry.body.includes(JOB_RESULT),
      )
    )
      return;
    assert.ok(Date.now() < deadline, "the old job's result did not reach the card");
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

test("a restarted worker hears the restart notice on its first turn even when an interrupted job result is already queued", async () => {
  const armed = join(tempDir("slow-restart-"), "armed");
  const jobStarted = `${armed}.job`;
  const jobRelease = `${armed}.job-release`;
  const command = `touch '${jobStarted}'; while [ ! -f '${jobRelease}' ]; do sleep 0.05; done; printf '%s\\n' '${JOB_RESULT}'; exit 130`;
  parts = await startDispatchLab({
    hosts: { slow: ["node", SLOW, armed] },
    roots: { slow: CHECKOUT },
  });
  const { h, mate, lab } = parts;
  for (let call = 0; call < 12; call += 1) {
    h.onModel(
      (turns) =>
        plan(turns, {
          "ship the scrollbar fix": [DISPATCH],
          "restart it": [{ tool: "restart_card", args: { card: 1 } }],
        }),
      "mate",
    );
    h.onModel(
      (turns) =>
        plan(turns, {
          "fix the scrollbar": [
            {
              tool: "run_long",
              args: { label: "wait", command },
            },
          ],
        }),
      "worker",
    );
  }
  await mateConnected(h);
  mate.prompt("ship the scrollbar fix");
  await h.waitForCall(1, "worker", WORKER_WAIT_MS);
  await poll(() => existsSync(jobStarted) || undefined, "the worker's job to run", WORKER_WAIT_MS);

  const group = await workerGroupOf(lab, "c-1-a1");
  assert.ok(group !== undefined && group > 0);
  process.kill(-group, "SIGKILL");
  const deadline = Date.now() + 30_000;
  while ((await workersOf(lab)).includes("c-1-a1")) {
    assert.ok(Date.now() < deadline, "the killed worker still runs");
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  writeFileSync(jobRelease, "release the old job\n");
  await waitForJobResult(parts);
  const next = h.callsOf("worker").length;
  writeFileSync(armed, "armed\n");
  mate.prompt("restart it", "followUp");
  const first = await h.waitForCall(next, "worker", WORKER_WAIT_MS);
  writeFileSync(`${armed}.released`, "released\n");

  assert.ok(
    first.some((turn) => turn.text.includes(NOTICE)),
    "the first turn carries the restart notice",
  );
  const returned = (turns: Turn[]): boolean =>
    toolResults(turns).some((result) => result.startsWith("Started c-1-a1 again on slow"));
  await poll(() => h.callsOf("mate").find(returned), "the restart to return", WORKER_WAIT_MS);
});
