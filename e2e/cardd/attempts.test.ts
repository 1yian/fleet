// Attempts, dispatch retries, replacement, capacity, and jobs (spec sections
// 6.9, 6.10, and 11), against a real cardd.
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { CardSchema, check, OPS, type Card } from "@fleet/protocol";
import type { Session } from "../support/cardd.ts";
import { newCard, startFleet, status, type Fleet } from "../support/fleet.ts";

let fleet: Fleet;
let card: Card;
beforeEach(async () => {
  fleet = await startFleet();
  card = await newCard(fleet.main, "Users see one scrollbar");
});
afterEach(async () => {
  await fleet.cardd.stop();
});

const begin = async (host: string, replace?: boolean) =>
  check(
    OPS["attempt.begin"].result,
    await fleet.main.call("attempt.begin", {
      card: card.id,
      host,
      ...(replace === undefined ? {} : { replace }),
    }),
  );
const c = (suffix = ""): string => `c-${String(card.id)}${suffix}`;

test("a dispatch retry before the worker connects finds the same attempt", async () => {
  const first = await begin("maverick");
  const retry = await begin("maverick");

  assert.deepEqual([first.session, first.resumed], [c("-a1"), false]);
  assert.deepEqual([retry.session, retry.token, retry.resumed], [first.session, first.token, true]);
  const worker = await fleet.cardd.connect(retry.token);
  assert.equal(worker.welcome?.session, c("-a1"));
  await assert.rejects(begin("maverick"), {
    message: `${c()} has an active attempt ${c("-a1")} on maverick`,
  });
});

test("replacing an attempt cuts off the old worker, even when it comes back", async () => {
  const first = await begin("p620");
  const old = await fleet.cardd.connect(first.token);
  await assert.rejects(begin("maverick"), {
    message: `${c()} has an active attempt ${c("-a1")} on p620`,
  });

  const second = await begin("maverick", true);
  assert.equal(second.session, c("-a2"));
  await assert.rejects(old.call("report", { status: "done", text: "late" }), {
    message: "the connection closed with 4001",
  });
  const back = await fleet.cardd.connect(first.token);
  assert.equal(back.closeCode, 4001);
  const worker = await fleet.cardd.connect(second.token);
  await worker.call("report", { status: "blocked", text: "the API is down" });
  assert.equal(await status(fleet.main, card), "with-mate");
});

test("a lane cannot take the name of a worker session, before or after dispatch", async () => {
  assert.throws(() => fleet.cardd.addLane(c("-a1")), /cannot name a lane/);

  const first = await begin("maverick");

  assert.equal(first.session, c("-a1"));
  const worker = await fleet.cardd.connect(first.token);
  assert.equal(worker.welcome?.session, c("-a1"));
  assert.throws(() => fleet.cardd.addLane(c("-a1")), /cannot name a lane/);
});

test("a project at capacity refuses another attempt", async () => {
  fleet.cardd.addProject("web", 1);
  const one = check(
    CardSchema,
    await fleet.main.call("card.new", { title: "one", kind: "ship", project: "web" }),
  );
  const two = check(
    CardSchema,
    await fleet.main.call("card.new", { title: "two", kind: "ship", project: "web" }),
  );
  await fleet.main.call("attempt.begin", { card: one.id, host: "maverick" });

  await assert.rejects(fleet.main.call("attempt.begin", { card: two.id, host: "maverick" }), {
    message: "project web is at capacity (1 workers)",
  });
});

test("a job result reaches the waiting worker once, through POST /call", async () => {
  const { token } = await begin("maverick");
  const worker: Session = await fleet.cardd.connect(token);
  const { job } = check(
    OPS["job.start"].result,
    await worker.call("job.start", { label: "tests", command: "npm test" }),
  );
  assert.deepEqual(await worker.call("jobs", {}), [{ id: job, label: "tests" }]);

  const finish = { job, exitCode: 1, outputTail: "1 failing" };
  assert.deepEqual(await fleet.cardd.post(token, "job.finish", finish), {
    status: 200,
    body: { ok: true, value: { recorded: true } },
  });
  assert.deepEqual(await fleet.cardd.post(token, "job.finish", finish), {
    status: 200,
    body: { ok: true, value: { recorded: false } },
  });
  await worker.call("jobs", {});
  assert.deepEqual(
    worker.entries.map(({ entry }) => [entry.kind, entry.body, entry.fields["exitCode"]]),
    [["job-result", "1 failing", 1]],
  );
  assert.deepEqual(await worker.call("jobs", {}), []);
});

test("POST /call refuses an unknown token and a mate-only operation from a worker", async () => {
  assert.deepEqual(await fleet.cardd.post("not-a-token", "jobs", {}), {
    status: 401,
    body: { ok: false, error: "unknown token, or the attempt ended" },
  });
  const { token } = await begin("maverick");
  assert.deepEqual(await fleet.cardd.post(token, "board", {}), {
    status: 400,
    body: { ok: false, error: "worker sessions cannot call board" },
  });
});
