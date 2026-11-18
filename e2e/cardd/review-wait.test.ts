import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { check, OPS, type Card, type Entry } from "@fleet/protocol";
import type { Session } from "../support/cardd.ts";
import { ageCard, begin, newCard, startFleet, status, type Fleet } from "../support/fleet.ts";

const MINUTE = 60_000;
const PAGE = "http://p620.example:8791/session/d4740031e34a46e8";
const BOARD = "/scratch/c-1600/board/index.html";
const POLLS = {
  plain: `lavish-axi poll ${BOARD} --owner fleet-c-1`,
  npx: `npx --yes lavish-axi poll '${BOARD}'`,
  versioned: "lavish-axi@1.2.3 poll page.html",
  redirected: `lavish-axi poll>poll.log ${BOARD}`,
  quotedNode: `node "$HOME/node_modules/lavish-axi/dist/cli.mjs" poll ${BOARD}`,
  chained: `cd /scratch && lavish-axi poll ${BOARD}`,
  pinned: `set -o pipefail; LAVISH_AXI_STATE_DIR=/scratch/c-1600/lavish-state LAVISH_AXI_PORT=8791 LAVISH_AXI_NO_OPEN=1 node /npx/node_modules/lavish-axi/dist/cli.mjs poll ${BOARD} --owner fleet-c-1 2>&1 | tee /scratch/c-1684/poll-delivery-20.txt`,
};
const NOT_POLLS = {
  reply: `lavish-axi reply ${BOARD} --agent-reply "I will poll again after your answer"`,
  search: "grep -n poll notes.txt",
  sibling: `lavish-axi-notes poll ${BOARD}`,
  printed: `make build | tee build.log; echo "to wait, run lavish-axi poll ${BOARD}" >&2`,
  echoed: "echo lavish-axi poll the page",
  escaped: `echo usage \\; lavish-axi poll ${BOARD}`,
  commented: `npm test # if approval is needed; lavish-axi poll ${BOARD}`,
  version: "npx --version lavish-axi poll",
  otherNode: "node scripts/lavish-axi.mjs poll page.html",
};

let fleet: Fleet;
let cleo: Session;
beforeEach(async () => {
  fleet = await startFleet({ CARDD_TIMING_SCALE: "0.1" });
  cleo = await fleet.cardd.connect(fleet.cardd.addLane("cleo", "main"));
});
afterEach(async () => {
  await fleet.cardd.stop();
});

async function laneCard(): Promise<{ card: Card; worker: Session }> {
  const card = await newCard(cleo, "Review the consolidated vision");
  const worker = await fleet.cardd.connect(await begin(cleo, card));
  return { card, worker };
}

const startJob = async (worker: Session, label: string, command: string): Promise<number> =>
  check(OPS["job.start"].result, await worker.call("job.start", { label, command })).job;

const finishJob = (worker: Session, job: number): Promise<unknown> =>
  worker.call("job.finish", { job, exitCode: 124, outputTail: "timed out with no feedback" });

const isReport = (card: Card) => (entry: Entry) =>
  entry.card === card.id && entry.kind === "report" && entry.fields["key"] === "plan-review";

test("a worker cannot wait on a Lavish page until its card holds a decision, and then its mate is asked", async () => {
  const { card, worker } = await laneCard();

  for (const [name, command] of Object.entries(POLLS)) {
    await assert.rejects(
      startJob(worker, "vision-approval-poll", command),
      /report needs-decision with a new review key and the page link/,
      `the ${name} poll is refused while nothing holds the card`,
    );
  }
  const board = check(OPS.board.result, await cleo.call("board", {}));
  assert.equal(board.find((each) => each.id === card.id)?.pulse?.running, null);
  assert.equal(await status(cleo, card), "working");

  for (const [name, command] of Object.entries(NOT_POLLS)) {
    const job = await startJob(worker, "other", command);
    await finishJob(worker, job);
    assert.ok(job > 0, `${name} is an ordinary job`);
  }

  await worker.call("report", {
    status: "needs-decision",
    key: "plan-review",
    text: `Review ready: ${PAGE}`,
  });
  await cleo.waitForEntry(isReport(card), "the worker's review decision");
  assert.equal(await status(cleo, card), "with-mate");

  for (const command of Object.values(POLLS)) {
    const job = await startJob(worker, "vision-approval-poll", command);
    await finishJob(worker, job);
  }
  const waiting = await startJob(worker, "vision-approval-poll", POLLS.pinned);
  await worker.call("report", { status: "working", text: "Still waiting on the page." });
  assert.equal(await status(cleo, card), "with-mate", "a working report does not lift the hold");

  ageCard(fleet.cardd, card, 11 * MINUTE);
  const list = await cleo.waitForEntry(
    (entry) => entry.author === "check" && entry.fields["condition"] === "decisions",
    "the mate's decision list",
  );
  assert.match(list.body, new RegExp(`c-${String(card.id)} Review the consolidated vision`));
  assert.match(list.body, /with-mate, owner hold/);
  assert.match(list.body, new RegExp(PAGE));
  assert.ok(waiting > 0);
});

test("a review decision that was answered is a decision no more: the next poll needs a new one", async () => {
  const { card, worker } = await laneCard();
  await worker.call("report", {
    status: "needs-decision",
    key: "plan-review",
    text: `Review ready: ${PAGE}`,
  });
  const first = await startJob(worker, "vision-approval-poll", POLLS.plain);
  await finishJob(worker, first);
  await startJob(worker, "vision-approval-poll", POLLS.plain);

  await cleo.call("comment", {
    card: card.id,
    text: "The captain is done.",
    resolves: "plan-review",
  });
  assert.equal(await status(cleo, card), "working");
  await assert.rejects(
    startJob(worker, "vision-approval-poll", POLLS.plain),
    /report needs-decision with a new review key and the page link/,
  );

  await worker.call("report", {
    status: "needs-decision",
    key: "plan-review-2",
    text: `Round two: ${PAGE}`,
  });
  await startJob(worker, "vision-approval-poll", POLLS.plain);
  assert.equal(await status(cleo, card), "with-mate");
});
