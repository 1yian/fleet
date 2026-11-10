import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { begin, newCard, oldDatedHold, startFleet, type Fleet } from "../support/fleet.ts";
import { Harness, type Turn } from "../support/harness.ts";

const EXTENSION = fileURLToPath(new URL("../../packages/extension/src/index.ts", import.meta.url));
const HOUR = 3_600_000;

let fleet: Fleet;
let h: Harness;
beforeEach(async () => {
  fleet = await startFleet();
  h = await Harness.start();
});
afterEach(async () => {
  await h.stop();
  await fleet.cardd.stop();
});

const toolResults = (turns: Turn[]): string[] =>
  turns.filter((turn) => turn.role === "toolResult").map((turn) => turn.text);

type Args = Readonly<Record<string, string | number | boolean | readonly number[]>>;

const soon = (): string => new Date(Date.now() + HOUR).toISOString();

test("the hold tool refuses a date that names no watcher or no remaining work, and the board shows each dated wait as one line", async () => {
  const quota = await newCard(fleet.main, "Wait for the quota", "captain");
  const vendor = await newCard(fleet.main, "Pick the vendor", "captain");
  const forgotten = await newCard(fleet.main, "Forgotten decision", "captain");
  const next = await newCard(fleet.main, "Port the rest", "captain");
  oldDatedHold(fleet.cardd, forgotten, "captain", Date.now() - 6 * 24 * HOUR, Date.now() + HOUR);

  const date = { until: soon(), question: "Wait for it?" };
  const calls: [string, Args][] = [
    ["hold", { card: quota.id, ...date }],
    ["hold", { card: quota.id, ...date, outside: "the weekly quota resets" }],
    ["hold", { card: quota.id, ...date, remaining: [] }],
    [
      "hold",
      {
        card: quota.id,
        ...date,
        outside: "the weekly quota resets",
        remaining: [next.id],
      },
    ],
    ["hold", { card: vendor.id, ...date, said: "he said later", remaining: [] }],
    ["hold", { card: vendor.id, ...date, said: "ask me again next week", remaining: [] }],
    ["board", {}],
    ["board", { card: quota.id }],
  ];
  for (const [tool, args] of calls) h.onModel(() => ({ tool, args }));
  h.onModel(() => ({ text: "recorded" }));
  const mate = h.startPi(
    "main",
    { FLEET_URL: fleet.cardd.url, FLEET_TOKEN: fleet.mainToken, FLEET_ROLE: "mate" },
    [EXTENSION],
  );
  await h.waitFor((e) => e["type"] === "fleet_connected", "the mate to connect");
  mate.prompt("The vendor can wait: ask me again next week.");

  const results = toolResults(await h.waitForCall(calls.length));
  assert.match(results[0] ?? "", /must say what it waits on, with exactly one of: job=.*idle park/);
  assert.match(results[1] ?? "", /must state the work that remains.*remaining=\[\]/);
  assert.match(results[2] ?? "", /exactly one of: job=/);
  assert.equal(results[3], `Held. c-${String(quota.id)} is now waiting.`);
  assert.match(results[4] ?? "", /not in the captain's messages or board entries/);
  assert.equal(results[5], `Held. c-${String(vendor.id)} is now waiting.`);

  const board = results[6] ?? "";
  const row = (id: number, line: string): RegExp =>
    new RegExp(`^ {2}${String(id)},"?${line}"?$`, "m");
  assert.match(board, /^dated\[3\]\{card,waits\}:$/m);
  assert.match(
    board,
    row(
      quota.id,
      "waits on an outside date: the weekly quota resets, until \\S+Z \\(in \\d+[hm]\\), held <1m",
    ),
  );
  assert.match(
    board,
    row(
      vendor.id,
      'the captain said later: \\\\"ask me again next week\\\\", until \\S+Z \\(in \\d+[hm]\\), held <1m',
    ),
  );
  assert.match(
    board,
    row(forgotten.id, "idle park, nothing running, until \\S+Z \\(in \\d+[hm]\\), held 6d"),
  );
  assert.match(
    board,
    new RegExp(`c-${String(forgotten.id)} hold a date with nothing running for it: start what`),
  );
  assert.doesNotMatch(board, new RegExp(`^ {2}${String(next.id)},"?waits`, "m"));

  const card = results[7] ?? "";
  assert.match(card, /dated: "?waits on an outside date: the weekly quota resets, until/);
  assert.match(
    card,
    new RegExp(`remaining\\[1\\]: c-${String(next.id)} Port the rest \\(queued\\)`),
  );
});

test("the hold tool takes a watcher that fleet can check, and the board shows the line gone once the worker's card closes", async () => {
  const cleo = await fleet.cardd.connect(fleet.cardd.addLane("cleo", "main"));
  const watched = await newCard(cleo, "Watched by a worker");
  await fleet.cardd.connect(await begin(cleo, watched));
  const waiter = await newCard(fleet.main, "Waits on a worker", "captain");
  const args = { card: waiter.id, until: soon(), question: "Done?", remaining: [] };
  h.onModel(() => ({ tool: "hold", args: { ...args, worker: watched.id } }));
  h.onModel(() => ({ tool: "board", args: {} }));
  h.onModel(() => ({ text: "held" }));
  h.onModel(() => ({ tool: "board", args: {} }));
  h.onModel(() => ({ text: "seen" }));
  const mate = h.startPi(
    "main",
    { FLEET_URL: fleet.cardd.url, FLEET_TOKEN: fleet.mainToken, FLEET_ROLE: "mate" },
    [EXTENSION],
  );
  await h.waitFor((e) => e["type"] === "fleet_connected", "the mate to connect");
  mate.prompt("Hold it until the worker is done.");

  const [held, running] = toolResults(await h.waitForCall(2));
  assert.equal(held, `Held. c-${String(waiter.id)} is now waiting.`);
  assert.match(
    running ?? "",
    new RegExp(`waits on the worker of c-${String(watched.id)}, until \\S+Z`),
  );
  assert.doesNotMatch(running ?? "", /idle park/);

  await cleo.call("close.finish", {
    card: watched.id,
    mode: "dropped",
    text: "Dropped.",
    archives: [],
    left: [],
  });
  mate.prompt("Look again.");
  const gone = toolResults(await h.waitForCall(4))[2];
  assert.match(
    gone ?? "",
    new RegExp(`idle park, nothing running: the worker of c-${String(watched.id)} is not running`),
  );
});
