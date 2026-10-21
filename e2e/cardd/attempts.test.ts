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
      task: "fix the scrollbar",
      ...(replace === undefined ? {} : { replace }),
    }),
  );
const c = (suffix = ""): string => `c-${String(card.id)}${suffix}`;

test("a dispatch retry finds the attempt that already started, with one task message", async () => {
  const first = await begin("maverick");
  const retry = await begin("maverick");

  assert.deepEqual(
    [first.session, first.resumed, first.clone, first.base, first.branch],
    [c("-a1"), false, "/clones/web", "main", c("-a1")],
  );
  assert.deepEqual(
    [retry.session, retry.token, retry.resumed, retry.active],
    [first.session, first.token, true, false],
  );
  const worker = await fleet.cardd.connect(retry.token);
  assert.equal(worker.welcome?.session, c("-a1"));
  const again = await begin("maverick");
  assert.deepEqual([again.session, again.resumed, again.active], [c("-a1"), true, true]);
  await fleet.main.call("board", {});
  assert.deepEqual(
    worker.entries.map(({ entry }) => [entry.kind, entry.body, entry.fields["task"]]),
    [["comment", "fix the scrollbar\n\nDelivery: no-mistakes", true]],
  );
  await assert.rejects(begin("p620"), {
    message: `${c()} has an active attempt ${c("-a1")} on maverick`,
  });
});

test("replacing an attempt cuts off the old worker, even when it comes back", async () => {
  const first = await begin("p620");
  const old = await fleet.cardd.connect(first.token);
  await assert.rejects(begin("maverick"), {
    message: `${c()} has an active attempt ${c("-a1")} on p620`,
  });
  assert.equal((await begin("p620")).resumed, true);

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

test("a project takes any number of workers at once", async () => {
  fleet.cardd.addProject("api", { maverick: "/clones/api" });
  const sessions: string[] = [];
  for (const title of ["one", "two", "three", "four", "five", "six"]) {
    const each = check(
      CardSchema,
      await fleet.main.call("card.new", { title, kind: "ship", project: "api" }),
    );
    const begun = check(
      OPS["attempt.begin"].result,
      await fleet.main.call("attempt.begin", { card: each.id, host: "maverick", task: title }),
    );
    assert.equal(begun.resumed, false);
    sessions.push(begun.session);
  }
  assert.equal(new Set(sessions).size, 6);
});

test("a clone registered for a host with a dot is found for that exact host", async () => {
  fleet.cardd.addProject("api", { "p620.tailnet": "/clones/api" });
  const api = check(
    CardSchema,
    await fleet.main.call("card.new", { title: "one", kind: "ship", project: "api" }),
  );
  const begun = check(
    OPS["attempt.begin"].result,
    await fleet.main.call("attempt.begin", { card: api.id, host: "p620.tailnet", task: "one" }),
  );
  assert.equal(begun.clone, "/clones/api");
  await assert.rejects(
    fleet.main.call("attempt.begin", { card: api.id, host: "p620", task: "one", replace: true }),
    { message: "project api has no clone on p620" },
  );
});

test("a clone given without a host or a path is refused when the project is added", () => {
  for (const clone of ["maverick", "=/clones/api", "maverick="])
    assert.throws(() => {
      fleet.cardd.addProjectWithCloneArgs("api", [clone]);
    }, /must be <host>=<path>/);
});

test("moving a project's clone changes the path for new attempts on that host only", async () => {
  const first = await begin("maverick");
  assert.equal(first.clone, "/clones/web");

  assert.equal(
    fleet.cardd.moveClone("web", "p620", "/fleet-projects/web"),
    "web: clone on p620 is /fleet-projects/web",
  );
  const listed = check(OPS.projects.result, await fleet.main.call("projects", {}));
  assert.deepEqual(listed[0]?.clones, [
    { host: "maverick", path: "/clones/web" },
    { host: "p620", path: "/fleet-projects/web" },
  ]);
  const second = await newCard(fleet.main, "Users see one scrollbar again");
  const moved = check(
    OPS["attempt.begin"].result,
    await fleet.main.call("attempt.begin", { card: second.id, host: "p620", task: "again" }),
  );
  assert.equal(moved.clone, "/fleet-projects/web");

  fleet.cardd.moveClone("web", "maverick", "/new/web");
  const again = await newCard(fleet.main, "Users see one scrollbar once more");
  const here = check(
    OPS["attempt.begin"].result,
    await fleet.main.call("attempt.begin", { card: again.id, host: "maverick", task: "x" }),
  );
  assert.equal(here.clone, "/new/web");
});

test("moving the clone of a project that is not registered, or with a bad clone, is refused", () => {
  assert.throws(
    () => fleet.cardd.moveClone("nope", "p620", "/x"),
    /project nope is not in the registry/,
  );
  for (const [host, path] of [
    ["", "/x"],
    ["p620", ""],
  ] as const)
    assert.throws(() => fleet.cardd.moveClone("web", host, path), /must be <host>=<path>/);
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
    [
      ["comment", "fix the scrollbar\n\nDelivery: no-mistakes", undefined],
      ["job-result", "1 failing", 1],
    ],
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
