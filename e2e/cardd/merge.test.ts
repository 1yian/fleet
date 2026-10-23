import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, test } from "node:test";
import { BoardSchema, check, MERGE_OPTIONS, OPS, type Card } from "@fleet/protocol";
import type { Session } from "../support/cardd.ts";
import { begin, newCard, startFleet, status, type Fleet } from "../support/fleet.ts";
import { tempDir } from "../support/run-root.ts";
import type { FakeGitHub } from "../support/github.ts";

const PR = "https://github.com/acme/web/pull/7";
const [APPROVE, CHANGES] = MERGE_OPTIONS;

let fleet: Fleet;
let gh: FakeGitHub;
beforeEach(async () => {
  fleet = await startFleet({ CARDD_TIMING_SCALE: "0.001" });
  fleet.cardd.moveClone("web", "maverick", tempDir("merge-web-"));
  gh = fleet.cardd.gh;
});
afterEach(async () => {
  await fleet.cardd.stop();
});

async function done(card: Card, pr = PR): Promise<Session> {
  const worker = await fleet.cardd.connect(await begin(fleet.main, card));
  await worker.call("report", { status: "done", text: "PR green and ready", pr });
  return worker;
}
const approve = (card: Card, choice: string = APPROVE) =>
  fleet.main.call("release", { card: card.id, words: "yes, merge it", source: "chat", choice });
const holdFor = (card: Card, question: string) =>
  fleet.main.call("hold", { card: card.id, question, options: ["a", "b"] });
async function merge(worker: Session, pr = PR): Promise<void> {
  gh.setPr(pr, "OPEN");
  execFileSync("gh", ["pr", "merge", pr, "--squash"], { env: { ...process.env, ...gh.env } });
  await worker.call("report", { status: "done", text: `merged ${pr}`, pr, merged: true });
}

test("a done ship card asks the captain; approval, the worker's merge, and the merged notice follow", async () => {
  const card = await newCard(fleet.main, "Users see one scrollbar");
  const worker = await done(card);
  assert.equal(await status(fleet.main, card), "needs-you");
  const report = await fleet.main.waitForEntry((entry) => entry.kind === "report", "the report");
  assert.equal(report.fields["pr"], PR);
  assert.equal((await fleet.cardd.board()).cards.find((each) => each.id === card.id)?.pr, PR);
  await assert.rejects(approve(card, "sure"), {
    message: `a merge question needs the choice "${APPROVE}" or "${CHANGES}"`,
  });

  await approve(card);
  assert.equal(await status(fleet.main, card), "merging");
  await fleet.main.call("comment", { card: card.id, text: "Merge your PR now." });
  assert.equal(await status(fleet.main, card), "merging");
  await merge(worker);
  assert.equal(await status(fleet.main, card), "merging");
  const plan = check(
    OPS["close.begin"].result,
    await fleet.main.call("close.begin", { card: card.id }),
  );
  assert.deepEqual([plan.mode, plan.verify], ["done", false]);
});

test("a done ship card whose worker reported no PR reaches its mate, with no merge question", async () => {
  const card = await newCard(fleet.main, "Users see one scrollbar");
  const worker = await fleet.cardd.connect(await begin(fleet.main, card));
  await assert.rejects(worker.call("report", { status: "done", text: "merged", merged: true }), {
    message: "a merged report must be done and name its PR URL",
  });
  await assert.rejects(
    worker.call("report", { status: "working", text: "merged", pr: PR, merged: true }),
    { message: "a merged report must be done and name its PR URL" },
  );
  await worker.call("report", { status: "done", text: "PR opened" });

  const report = await fleet.main.waitForEntry((entry) => entry.kind === "report", "the report");
  assert.match(String(report.fields["prNote"]), /^no PR URL reported/);
  assert.equal(report.fields["pr"], undefined);
  assert.equal(await status(fleet.main, card), "with-mate");
  assert.deepEqual((await fleet.cardd.board()).holds, []);

  await worker.call("report", { status: "done", text: `PR ${PR} opened`, pr: PR });
  assert.equal(await status(fleet.main, card), "needs-you");
});

test("request changes sends the card back to the worker", async () => {
  const card = await newCard(fleet.main, "Users see one scrollbar");
  await done(card);
  await approve(card, CHANGES);
  assert.equal(await status(fleet.main, card), "working");
});

test("a done report while another hold is open adds no second hold: the merge question follows its release", async () => {
  const card = await newCard(fleet.main, "Users see one scrollbar");
  const worker = await fleet.cardd.connect(await begin(fleet.main, card));
  await holdFor(card, "Which name?");
  await worker.call("report", { status: "done", text: "PR green and ready", pr: PR });
  const open = () => fleet.cardd.board().then((board) => board.holds);
  assert.deepEqual(
    (await open()).map((hold) => [hold.card, hold.merge]),
    [[card.id, false]],
  );

  await fleet.main.call("release", {
    card: card.id,
    words: "a it is",
    source: "chat",
    choice: "a",
  });
  assert.deepEqual(
    (await open()).map((hold) => [hold.card, hold.merge]),
    [[card.id, true]],
  );
  assert.equal(await status(fleet.main, card), "needs-you");
  await approve(card);
  assert.equal(await status(fleet.main, card), "merging");
});

test("a project's yolo flag sends a done card to Merging without a question, but only in its project", async () => {
  fleet.cardd.addProject("api", { maverick: "/clones/api" });
  assert.equal(fleet.cardd.yolo("api"), "api: yolo on");
  const outside = await newCard(fleet.main, "outside the flag");
  await done(outside);
  assert.equal(await status(fleet.main, outside), "needs-you");

  fleet.cardd.yolo("web");
  const inside = await newCard(fleet.main, "inside the flag");
  const pr = "https://github.com/acme/web/pull/8";
  const insideWorker = await done(inside, pr);
  assert.equal(await status(fleet.main, inside), "merging");
  assert.equal((await fleet.cardd.board()).holds.length, 1);
  await merge(insideWorker, pr);
  const plan = check(
    OPS["close.begin"].result,
    await fleet.main.call("close.begin", { card: inside.id }),
  );
  assert.deepEqual([plan.mode, plan.verify], ["done", false]);

  fleet.cardd.yolo("web", false);
  const after = await newCard(fleet.main, "after the flag");
  await done(after, "https://github.com/acme/web/pull/9");
  assert.equal(await status(fleet.main, after), "needs-you");
});

test("a mate cannot turn a project's yolo flag on: no operation sets it, and projects shows it", async () => {
  const flags = async () =>
    check(OPS.projects.result, await fleet.main.call("projects", {})).map((p) => [p.name, p.yolo]);
  const grant = { lane: "main", project: "web", words: "merge it", may: "merge", merge: true };
  assert.deepEqual(await fleet.cardd.post(fleet.mainToken, "grant", grant), {
    status: 400,
    body: { ok: false, error: "unknown operation grant" },
  });
  assert.deepEqual(await flags(), [["web", false]]);
  fleet.cardd.yolo("web");
  assert.deepEqual(await flags(), [["web", true]]);
});

test("a second done report does not add a second merge question", async () => {
  const card = await newCard(fleet.main, "Users see one scrollbar");
  const worker = await done(card);
  await worker.call("report", { status: "done", text: "still green", pr: PR });
  await approve(card);
  await assert.rejects(approve(card), { message: `c-${String(card.id)} has no open hold` });
});

test("a second mate's merge question waits on main, which escalates it to the captain", async () => {
  const cleo = await fleet.cardd.connect(fleet.cardd.addLane("cleo", "main"));
  const card = await newCard(cleo, "Ads stay under budget");
  const worker = await fleet.cardd.connect(await begin(cleo, card));
  await worker.call("report", { status: "done", text: "PR green", pr: PR });

  assert.equal(await status(cleo, card), "with-mate");
  assert.deepEqual((await fleet.cardd.board()).holds, []);
  const line = await fleet.main.waitForEntry((entry) => entry.kind === "hold", "the merge line");
  assert.equal(line.body, `Merge ${PR} for c-${String(card.id)}: Ads stay under budget?`);

  await fleet.main.call("hold", { card: card.id, to: "captain", question: `Merge ${PR}?` });
  assert.equal(await status(cleo, card), "needs-you");
  assert.deepEqual(
    (await fleet.cardd.board()).holds.map((hold) => [hold.card, hold.merge]),
    [[card.id, true]],
  );
});

test("an approval still stands after a later question takes the card back to the captain", async () => {
  const card = await newCard(fleet.main, "Users see one scrollbar");
  await done(card);
  await approve(card);
  await holdFor(card, "Also clean up the old run?");
  assert.equal(await status(fleet.main, card), "needs-you");

  await fleet.main.call("release", {
    card: card.id,
    words: "a it is",
    source: "chat",
    choice: "a",
  });
  assert.equal(await status(fleet.main, card), "merging");
  assert.deepEqual((await fleet.cardd.board()).holds, []);
});

test("the captain's own words on a merge question from the board ask for changes, and never approve", async () => {
  const card = await newCard(fleet.main, "Users see one scrollbar");
  await done(card);
  const http = fleet.cardd.url.replace(/^ws/, "http").replace(/\/session$/, "/");
  const board = check(BoardSchema, await (await fetch(`${http}api/board`)).json());
  const question = board.holds.find((each) => each.card === card.id);
  assert.equal(question?.merge, true);
  const revision = board.cards.find((each) => each.id === card.id)?.revision;
  const action = { kind: "answer", hold: question.hold, choice: APPROVE, written: true };
  const response = await fetch(`${http}api/action`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ card: card.id, revision, action }),
  });
  assert.equal(response.status, 200);

  assert.equal(await status(fleet.main, card), "working");
  assert.deepEqual((await fleet.cardd.board()).holds, []);
});

test("a worker's merged report makes the open merge question moot, and the card closes as Done", async () => {
  const card = await newCard(fleet.main, "Users see one scrollbar");
  const worker = await done(card);
  assert.equal(await status(fleet.main, card), "needs-you");
  const close = { card: card.id };
  await assert.rejects(fleet.main.call("close.begin", close), {
    message: `c-${String(card.id)} has an open hold; clear it first with hold(card, clear=true), with the captain's words when it waits on him`,
  });

  await worker.call("report", { status: "done", text: `merged ${PR}`, pr: PR, merged: true });
  assert.equal(await status(fleet.main, card), "with-mate");
  assert.deepEqual((await fleet.cardd.board()).holds, []);
  const plan = check(OPS["close.begin"].result, await fleet.main.call("close.begin", close));
  assert.deepEqual([plan.mode, plan.verify], ["done", false]);
  await assert.rejects(fleet.main.call("close.begin", { ...close, landed: false }), {
    message: `c-${String(card.id)}'s PR merged, so its work landed: close it without landed=false`,
  });
});

test("close re-verifies a reported PR that GitHub now shows merged, and closes it as Done", async () => {
  fleet.cardd.yolo("web");
  const card = await newCard(fleet.main, "Users see one scrollbar");
  await done(card);
  gh.setPr(PR, "MERGED");
  const plan = check(
    OPS["close.begin"].result,
    await fleet.main.call("close.begin", { card: card.id, landed: true }),
  );
  assert.deepEqual([plan.mode, plan.verify], ["done", false]);
  const closed = await fleet.main.call("close.finish", {
    card: card.id,
    mode: "done",
    text: "closed",
    archives: [],
    left: [],
  });
  assert.equal(check(OPS["close.finish"].result, closed).status, "done");
  await assert.rejects(fleet.main.call("close.begin", { card: card.id, landed: false }), {
    message: `c-${String(card.id)} is already done`,
  });
});

test("close names the access problem when GitHub cannot be asked about the PR", async () => {
  fleet.cardd.yolo("web");
  const card = await newCard(fleet.main, "Users see one scrollbar");
  await done(card);
  await assert.rejects(fleet.main.call("close.begin", { card: card.id }), {
    message: new RegExp(
      `could not be checked on GitHub .*Fix the access to the project's GitHub account, then close it again`,
    ),
  });
});

test("a done ship card whose PR has not merged does not close as Done", async () => {
  fleet.cardd.yolo("web");
  const card = await newCard(fleet.main, "Users see one scrollbar");
  const worker = await done(card);
  gh.setPr(PR, "OPEN");
  assert.equal(await status(fleet.main, card), "merging");
  await assert.rejects(fleet.main.call("close.begin", { card: card.id }), {
    message: `c-${String(card.id)} did not land: its PR ${PR} has not merged on GitHub. Once the merge is authorized (yolo on with green checks, or the captain's word for this PR), comment the worker to merge it and report it merged, then close it. To end it anyway, call close(card, summary=<why it is dropped>, landed=false). That marks it Dropped and archives its work.`,
  });
  await merge(worker);
  const plan = check(
    OPS["close.begin"].result,
    await fleet.main.call("close.begin", { card: card.id }),
  );
  assert.deepEqual([plan.mode, plan.verify], ["done", false]);
});
