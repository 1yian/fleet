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

const begin = async (host: string) =>
  check(
    OPS["attempt.begin"].result,
    await fleet.main.call("attempt.begin", {
      card: card.id,
      host,
      task: "fix the scrollbar",
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
    message: `${c()} already has work on maverick: use restart_card`,
  });
});

test("an explicit worker model survives retry and resume without changing the attempt", async () => {
  const request = {
    card: card.id,
    host: "maverick",
    task: "Review Spanish copy",
    model: "openai-codex/gpt-fixture",
  };
  const first = check(OPS["attempt.begin"].result, await fleet.main.call("attempt.begin", request));
  const retry = await begin("maverick");
  const resumed = check(
    OPS["attempt.resume"].result,
    await fleet.main.call("attempt.resume", { card: card.id }),
  );
  assert.equal(first.model, request.model);
  assert.equal(retry.model, request.model);
  assert.equal(resumed.model, request.model);
  assert.equal(resumed.session, first.session);
  await assert.rejects(
    fleet.main.call("attempt.begin", { ...request, model: "tier/quick" }),
    /a running attempt keeps its model/,
  );
});

test("a restart cannot avoid the provider of the worker's explicit model, and refusing it records nothing", async () => {
  await fleet.main.call("attempt.begin", {
    card: card.id,
    host: "maverick",
    task: "Review Spanish copy",
    model: "openai-codex/gpt-fixture",
  });
  const restart = (avoid?: string[]) =>
    fleet.main.call("card.restart", {
      card: card.id,
      mode: "replace",
      key: "gpt-restart",
      ...(avoid === undefined ? {} : { avoid }),
    });
  await assert.rejects(restart(["claude-max", "openai-codex"]), /cannot avoid openai-codex/);
  const other = check(OPS["card.restart"].result, await restart(["claude-max"]));
  assert.equal(other.repeat, false);
  const plain = check(OPS["card.restart"].result, await restart());
  assert.equal(plain.repeat, true);
});

test("the card's own mate re-pins a live attempt's model with a restart, and every later restart launches it", async () => {
  const pinned = "anthropic-3/claude-fixture:medium";
  await fleet.main.call("attempt.begin", {
    card: card.id,
    host: "maverick",
    task: "Build the iOS screens",
    model: pinned,
  });
  const resume = async () =>
    check(OPS["attempt.resume"].result, await fleet.main.call("attempt.resume", { card: card.id }));
  const modelOnBoard = async () =>
    check(OPS.card.result, await fleet.main.call("card", { card: card.id })).attempts.map(
      ({ model }) => model,
    );
  const restart = (args: Record<string, unknown>) =>
    fleet.main.call("card.restart", { card: card.id, mode: "replace", ...args });

  assert.equal((await resume()).model, pinned);
  assert.deepEqual(await modelOnBoard(), [pinned]);

  await assert.rejects(
    restart({ key: "bad", mode: "retry", model: "tier/visual" }),
    /model applies only when a worker's process is replaced/,
  );
  assert.equal((await resume()).model, pinned);

  const first = check(
    OPS["card.restart"].result,
    await restart({ key: "repin", model: "tier/visual" }),
  );
  assert.equal(first.repeat, false);
  const after = await resume();
  assert.equal(after.model, "tier/visual");
  assert.equal(after.session, c("-a1"));
  assert.equal(after.branch, c("-a1"));
  assert.deepEqual(await modelOnBoard(), ["tier/visual"]);

  const again = check(OPS["card.restart"].result, await restart({ key: "plain" }));
  assert.equal(again.repeat, false);
  assert.equal((await resume()).model, "tier/visual");

  const thread = check(OPS.card.result, await fleet.main.call("card", { card: card.id })).entries;
  const notes = thread.filter(
    (entry) => entry.fields["model"] !== undefined && entry.kind === "note",
  );
  assert.deepEqual(
    notes.map((entry) => entry.body),
    [`Model pin changed from ${pinned} to tier/visual. Every restart keeps it.`],
  );
});

test("a restart that is refused, or comes from another lane, leaves the pinned model as it was", async () => {
  const pinned = "anthropic-3/claude-fixture:medium";
  await fleet.main.call("attempt.begin", {
    card: card.id,
    host: "maverick",
    task: "Build it",
    model: pinned,
  });
  const other = await fleet.cardd.connect(fleet.cardd.addLane("other", "main"));
  await assert.rejects(
    other.call("card.restart", { card: card.id, mode: "replace", key: "x", model: "tier/visual" }),
    /only the direct parent can/,
  );
  await assert.rejects(
    fleet.main.call("card.restart", {
      card: card.id,
      mode: "replace",
      key: "y",
      model: "tier/visual",
      avoid: ["tier"],
    }),
    /cannot avoid tier/,
  );
  await assert.rejects(
    fleet.main.call("card.restart", {
      card: card.id,
      mode: "replace",
      key: "z",
      model: "not-a-model",
    }),
    /pattern/,
  );
  const resumed = check(
    OPS["attempt.resume"].result,
    await fleet.main.call("attempt.resume", { card: card.id }),
  );
  assert.equal(resumed.model, pinned);
  const thread = check(OPS.card.result, await fleet.main.call("card", { card: card.id })).entries;
  assert.deepEqual(
    thread.filter((entry) => entry.kind === "note"),
    [],
  );
});

const modelOf = async (): Promise<string | undefined> =>
  check(OPS["attempt.resume"].result, await fleet.main.call("attempt.resume", { card: card.id }))
    .model;
const restartWith = async (args: Record<string, unknown>) =>
  check(
    OPS["card.restart"].result,
    await fleet.main.call("card.restart", { card: card.id, mode: "replace", ...args }),
  );
const pinNotes = async (): Promise<string[]> =>
  check(OPS.card.result, await fleet.main.call("card", { card: card.id }))
    .entries.filter((entry) => entry.kind === "note" && entry.fields["model"] !== undefined)
    .map((entry) => entry.body);

test("a restart sets the model of a worker that was dispatched without one", async () => {
  await fleet.main.call("attempt.begin", { card: card.id, host: "maverick", task: "Build it" });
  assert.equal(await modelOf(), undefined);

  assert.equal((await restartWith({ key: "first", model: "tier/visual" })).repeat, false);
  assert.equal(await modelOf(), "tier/visual");
  assert.deepEqual(await pinNotes(), [
    "Model pin changed from the lane's normal model selection to tier/visual. Every restart keeps it.",
  ]);
});

test("a repeated restart key never re-applies its model after a later restart changed it", async () => {
  const pinned = "anthropic-3/claude-fixture:medium";
  const later = "openai-codex/gpt-fixture";
  await fleet.main.call("attempt.begin", {
    card: card.id,
    host: "maverick",
    task: "Build it",
    model: pinned,
  });

  assert.equal((await restartWith({ key: "a", model: "tier/visual" })).repeat, false);
  assert.equal((await restartWith({ key: "b", model: later })).repeat, false);
  assert.equal((await restartWith({ key: "a", model: "tier/visual" })).repeat, true);

  assert.equal(await modelOf(), later);
  assert.deepEqual(await pinNotes(), [
    `Model pin changed from ${pinned} to tier/visual. Every restart keeps it.`,
    `Model pin changed from tier/visual to ${later}. Every restart keeps it.`,
  ]);
});

test("a repeated incident restart keeps the model a later restart chose, and avoid is checked against the model the restart launches", async () => {
  const pinned = "anthropic-3/claude-fixture:medium";
  const later = "openai-codex/gpt-fixture";
  const first = check(
    OPS["attempt.begin"].result,
    await fleet.main.call("attempt.begin", {
      card: card.id,
      host: "maverick",
      task: "Build it",
      model: pinned,
    }),
  );
  const worker = await fleet.cardd.connect(first.token);
  await worker.call("incident.report", {
    error: "claude-max 5h quota has exhausted. Restart worker to launch on a new provider.",
  });
  const heard = await fleet.main.waitForEntry(
    (entry) => entry.card === card.id && entry.fields["condition"] === "runtime-failure",
    "the quota failure",
  );
  const found = /Incident (\d+), process generation (\d+)/.exec(heard.body);
  const incident = { incident: Number(found?.[1]), generation: Number(found?.[2]) };
  const request = { ...incident, key: "i", model: "tier/visual", avoid: ["anthropic-3"] };

  assert.equal((await restartWith(request)).repeat, false);
  assert.equal(await modelOf(), "tier/visual");
  assert.equal((await restartWith({ key: "o", model: later })).repeat, false);
  assert.equal((await restartWith(request)).repeat, true);

  assert.equal(await modelOf(), later);
  assert.deepEqual(await pinNotes(), [
    `Model pin changed from ${pinned} to tier/visual. Every restart keeps it.`,
    `Model pin changed from tier/visual to ${later}. Every restart keeps it.`,
  ]);
});

test("dispatch only starts new work: another host is refused while the worker lives, and its token keeps working", async () => {
  const first = await begin("p620");
  const worker = await fleet.cardd.connect(first.token);
  await assert.rejects(begin("maverick"), {
    message: `${c()} already has work on p620: use restart_card`,
  });
  assert.equal((await begin("p620")).resumed, true);
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
  const other = check(
    CardSchema,
    await fleet.main.call("card.new", { title: "two", kind: "ship", project: "api" }),
  );
  await assert.rejects(
    fleet.main.call("attempt.begin", { card: other.id, host: "p620", task: "two" }),
    {
      message: "project api has no clone on p620",
    },
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

test("a worker records its branch name once, a restart finds it, and the card shows it", async () => {
  const first = await begin("maverick");
  assert.equal(first.branch, c("-a1"));
  const worker = await fleet.cardd.connect(first.token);

  const named = await worker.call("branch.name", { name: "fix/scrollbar-doubles" });
  assert.deepEqual(named, { branch: "fix/scrollbar-doubles", previous: c("-a1") });
  assert.deepEqual(await worker.call("branch.name", { name: "fix/scrollbar-doubles" }), {
    branch: "fix/scrollbar-doubles",
    previous: "fix/scrollbar-doubles",
  });
  await assert.rejects(worker.call("branch.name", { name: "fix/another-name" }), {
    message: `${c("-a1")} already has its branch fix/scrollbar-doubles. Keep working on it: a branch is named once`,
  });

  assert.equal((await begin("maverick")).branch, "fix/scrollbar-doubles");
  const view = check(OPS.card.result, await fleet.main.call("card", { card: card.id }));
  assert.deepEqual(
    view.attempts.map(({ n, branch }) => [n, branch]),
    [[1, "fix/scrollbar-doubles"]],
  );
});

test("a branch name must be <type>/<slug>, and another live attempt's name is refused", async () => {
  const worker = await fleet.cardd.connect((await begin("maverick")).token);
  const shape =
    "must be <type>/<slug>, with a type of feat, fix, refactor, perf, docs, test, chore, ci, build and a lowercase kebab-case slug of at most 48 characters, such as fix/mileage-readback";
  for (const name of [
    c("-a1"),
    "fix",
    "fix/",
    "fix/Upper-Case",
    "fix/two--dashes",
    "fix/a/b",
    "wip/something",
    `fix/${"a".repeat(49)}`,
  ]) {
    await assert.rejects(worker.call("branch.name", { name }), {
      message: `branch name "${name}" ${shape}`,
    });
  }
  await worker.call("branch.name", { name: `fix/${"a".repeat(48)}` });

  const other = await newCard(fleet.main, "Another card");
  const begun = check(
    OPS["attempt.begin"].result,
    await fleet.main.call("attempt.begin", { card: other.id, host: "maverick", task: "go" }),
  );
  const second = await fleet.cardd.connect(begun.token);
  await assert.rejects(second.call("branch.name", { name: `fix/${"a".repeat(48)}` }), {
    message: `branch fix/${"a".repeat(48)} is already the branch of c-${String(card.id)}`,
  });
  await second.call("branch.name", { name: "fix/other-work" });
});
