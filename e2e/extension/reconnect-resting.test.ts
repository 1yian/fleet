import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { gate, type Move, type Turn } from "../support/harness.ts";
import {
  lastUser,
  mateConnected,
  startDispatchLab,
  stopDispatchLab,
  toolResults,
  WORKER_WAIT_MS,
  workerGroupOf,
  type DispatchLab,
} from "../support/dispatch-lab.ts";

let parts: DispatchLab;
beforeEach(async () => {
  parts = await startDispatchLab();
});
afterEach(async (t) => {
  try {
    if ("passed" in t && !t.passed)
      t.diagnostic(
        JSON.stringify({
          responses: parts.mate.responses,
          state: await parts.mate.state(),
          calls: parts.h.callsOf("mate"),
          workers: parts.h.callsOf("worker"),
          card: await cardOne(),
          thread: await parts.cardd.thread(1),
        }),
      );
    await parts.lab.printIfFailed(t);
  } finally {
    await stopDispatchLab(parts);
  }
});

async function until<T>(
  read: () => T | undefined | Promise<T | undefined>,
  what: string,
): Promise<T> {
  const deadline = Date.now() + WORKER_WAIT_MS;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

const cardOne = async () => (await parts.cardd.board()).cards.find((card) => card.id === 1);

const plan = (turns: Turn[], plans: Record<string, readonly Move[]>): Move => {
  const at = turns.findLastIndex((turn) => turn.role === "user");
  const done = turns.slice(at).filter((turn) => turn.role === "toolResult").length;
  const ask = turns[at]?.text ?? "";
  const moves = Object.entries(plans).find(([key]) => ask.includes(key))?.[1] ?? [];
  return moves[done] ?? { text: "noted" };
};

function scriptRestart(notification: ReturnType<typeof gate>): void {
  const { h } = parts;
  const until1h = new Date(Date.now() + 3_600_000).toISOString();
  const dispatch = {
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
  };
  const pause = {
    tool: "report",
    args: { status: "paused", text: "waiting for CI", until: until1h },
  };
  for (let call = 0; call < 12; call += 1) {
    h.onModel(async (turns) => {
      if (lastUser(turns)?.includes("Synthetic maintenance notification")) await notification.wait;
      return plan(turns, {
        "ship the scrollbar fix": [dispatch],
        "reconnect the worker": [{ tool: "restart_card", args: { card: 1, key: "reconnect" } }],
        "send the wake-up": [
          { tool: "comment", args: { card: 1, text: "WAKE-UP the wait is over" } },
        ],
      });
    }, "mate");
    h.onModel(
      (turns) => plan(turns, { "fix the scrollbar": [pause], "WAKE-UP": [{ text: "woke" }] }),
      "worker",
    );
  }
}

async function queuedPrompt(message: string): Promise<void> {
  const { mate } = parts;
  const prompts = mate.responses.filter((entry) => entry["command"] === "prompt").length;
  mate.prompt(message, "followUp");
  const response = await until(
    () => mate.responses.filter((entry) => entry["command"] === "prompt")[prompts],
    `RPC acceptance of ${message}`,
  );
  assert.equal(response["success"], true, JSON.stringify(response));
}

async function overlapNotification(): Promise<void> {
  const { cardd, mate, h } = parts;
  await until(
    async () => ((await mate.state())["isStreaming"] === false ? true : undefined),
    "the mate to settle",
  );
  const ops = await cardd.connect(cardd.addLane("ops", "main"));
  try {
    await ops.call("comment", {
      lane: "ops",
      text: "Synthetic maintenance notification",
    });
  } finally {
    await ops.close();
  }
  await until(
    () =>
      h
        .callsOf("mate")
        .some((turns) => lastUser(turns)?.includes("Synthetic maintenance notification"))
        ? true
        : undefined,
    "the overlapping notification",
  );
  assert.equal((await mate.state())["isStreaming"], true);
}

async function reconnectPaused(
  overlap: boolean,
  notification: ReturnType<typeof gate>,
): Promise<void> {
  const { h, lab } = parts;
  await mateConnected(h);
  await queuedPrompt("ship the scrollbar fix");
  await until(async () => ((await cardOne())?.status === "paused" ? true : undefined), "the pause");
  await until(
    () =>
      Promise.resolve(
        h
          .callsOf("mate")
          .flatMap((turns) => toolResults(turns))
          .find((text) => text.includes("Dispatched c-1-a1")),
      ),
    "the completed dispatch",
  );
  const gone = await until(() => workerGroupOf(lab, "c-1-a1"), "the worker's process");
  process.kill(-gone, "SIGKILL");
  await until(
    async () => ((await cardOne())?.activity?.state === "lost" ? true : undefined),
    "the worker to be lost",
  );

  if (overlap) await overlapNotification();
  await queuedPrompt("reconnect the worker");
  notification.open();
  const result = await until(
    () =>
      Promise.resolve(
        h
          .callsOf("mate")
          .flatMap((turns) => toolResults(turns))
          .find((text) => text.startsWith("Started c-1-a1 again")),
      ),
    "the restart result",
  );
  assert.match(result, /The card keeps its state: nothing was resumed/);
  await until(async () => {
    const group = await workerGroupOf(lab, "c-1-a1");
    return group !== undefined && group !== gone ? group : undefined;
  }, "the new process");
  await until(
    async () => ((await cardOne())?.activity?.state === "idle" ? true : undefined),
    "the new process to connect",
  );
  assert.equal((await cardOne())?.status, "paused");
  assert.deepEqual(
    (await parts.cardd.thread(1)).entries.filter((entry) => entry.fields["for"] === "worker"),
    [],
  );
  assert.equal(
    h.callsOf("worker").some((turns) => turns.some((turn) => turn.text.includes("was restarted"))),
    false,
  );

  await queuedPrompt("send the wake-up");
  await until(
    () =>
      Promise.resolve(
        h
          .callsOf("worker")
          .find((turns) => (lastUser(turns) ?? "").includes("WAKE-UP the wait is over")),
      ),
    "the worker to hear the comment",
  );
}

for (const overlap of [false, true]) {
  test(`restart_card reconnects the worker of a paused card whose process is gone, keeps the card paused, and the next comment reaches it${overlap ? " during a mate notification" : ""}`, async () => {
    const notification = gate();
    scriptRestart(notification);
    try {
      await reconnectPaused(overlap, notification);
    } finally {
      notification.open();
    }
  });
}
