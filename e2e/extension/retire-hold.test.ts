import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { CardSchema, check, type Card } from "@fleet/protocol";
import type { Session } from "../support/cardd.ts";
import { begin, newCard, startFleet, status, type Fleet } from "../support/fleet.ts";
import { Harness, type Turn } from "../support/harness.ts";

const EXTENSION = fileURLToPath(new URL("../../packages/extension/src/index.ts", import.meta.url));
const SUPERSEDING_PR = "https://github.com/acme/web/pull/420";
const UNRECORDED_PR = "https://github.com/acme/web/pull/421";
const OLDER_PR = "https://github.com/acme/web/pull/410";
const DROPPED_PR = "https://github.com/acme/web/pull/411";
const HIDDEN_PR = "https://github.com/acme/web/pull/412";
const OPTIONS = ["Approve the apply", "Do not apply"];
const WHY = "The cancelled run changed nothing and PR 420 replaced it.";

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

async function runMain(calls: number): Promise<string[]> {
  h.onModel(() => ({ text: "handled" }));
  h.startPi(
    "main",
    { FLEET_URL: fleet.cardd.url, FLEET_TOKEN: fleet.mainToken, FLEET_ROLE: "mate" },
    [EXTENSION],
  );
  await h.waitFor((e) => e["type"] === "fleet_connected", "main to connect");
  return toolResults(await h.waitForCall(calls + 1));
}

const retire = (card: Card, extra: Record<string, unknown>) => ({
  tool: "hold",
  args: { card: card.id, clear: true, retire: WHY, ...extra },
});

async function finishedWithPr(cleo: Session, title: string, pr: string): Promise<Card> {
  const card = await newCard(cleo, title);
  const worker = await fleet.cardd.connect(await begin(cleo, card));
  await worker.call("report", { status: "done", text: "PR ready", pr });
  return card;
}

async function staleDecision(cleo: Session, title: string): Promise<Card> {
  const card = await newCard(cleo, title, "scout");
  const worker = await fleet.cardd.connect(await begin(cleo, card));
  await worker.call("report", { status: "needs-decision", key: "apply", text: "Apply it?" });
  await cleo.call("hold", {
    card: card.id,
    question: "Approve the risky apply?",
    options: OPTIONS,
  });
  await fleet.main.call("hold", {
    card: card.id,
    to: "captain",
    question: "Apply?",
    options: OPTIONS,
  });
  return card;
}

const refused = (card: Card): string => `c-${String(card.id)}`;

async function dropped(cleo: Session, title: string, pr?: string): Promise<Card> {
  const card = await newCard(cleo, title);
  const worker = await fleet.cardd.connect(await begin(cleo, card));
  if (pr !== undefined) await worker.call("report", { status: "in-review", text: "PR up", pr });
  await cleo.call("close.finish", {
    card: card.id,
    mode: "dropped",
    text: "not wanted",
    archives: [],
    left: [],
  });
  return card;
}

test("main retires a stale captain hold once its action is cancelled and replaced, and refuses every superseder that is not real, newer work in the same project", async () => {
  const cleo = await fleet.cardd.connect(fleet.cardd.addLane("cleo", "main"));
  fleet.cardd.addProject("other", { maverick: "/clones/other" }, "acme/other");
  const older = await finishedWithPr(cleo, "Older work", OLDER_PR);
  const stale = await staleDecision(cleo, "Review the apply of PR 417");
  fleet.cardd.endAttemptsByHand(stale.id);
  assert.equal(await status(cleo, stale), "needs-you");
  await assert.rejects(
    cleo.call("release", { card: stale.id, retire: { reason: WHY, supersededBy: 99 } }),
    { message: `${refused(stale)} waits on the captain, so only main retires it: ask main` },
  );

  await finishedWithPr(cleo, "Apply PR 420", SUPERSEDING_PR);
  const gone = await dropped(cleo, "Abandoned idea");
  await dropped(cleo, "Abandoned apply", DROPPED_PR);
  const elsewhere = check(
    CardSchema,
    await cleo.call("card.new", { title: "Apply elsewhere", kind: "scout", project: "other" }),
  );
  const name = refused(stale);
  h.onModel(() => retire(stale, {}));
  h.onModel(() => ({ tool: "hold", args: { card: stale.id, clear: true, supersededBy: 1 } }));
  h.onModel(() => retire(stale, { supersededBy: stale.id }));
  h.onModel(() => retire(stale, { supersededBy: UNRECORDED_PR }));
  h.onModel(() => retire(stale, { supersededBy: gone.id }));
  h.onModel(() => retire(stale, { supersededBy: DROPPED_PR }));
  h.onModel(() => retire(stale, { supersededBy: older.id }));
  h.onModel(() => retire(stale, { supersededBy: OLDER_PR }));
  h.onModel(() => retire(stale, { supersededBy: elsewhere.id }));
  h.onModel(() => retire(stale, { supersededBy: SUPERSEDING_PR }));
  const results = await runMain(10);
  const said = (n: number): string => results[n] ?? "";

  assert.match(said(0), /retiring a hold needs both retire/);
  assert.match(said(1), /retiring a hold needs both retire/);
  assert.equal(said(2), `${name} cannot supersede its own hold`);
  assert.equal(said(3), `no card has recorded ${UNRECORDED_PR}, so it supersedes nothing`);
  assert.equal(said(4), `${refused(gone)} was dropped, so it supersedes nothing`);
  assert.match(said(5), /^c-\d+ was dropped, so it supersedes nothing$/);
  const tooOld = `${refused(older)} is older than ${name}'s hold, so it cannot have replaced it`;
  assert.equal(said(6), tooOld);
  assert.equal(said(7), tooOld);
  assert.equal(
    said(8),
    `${refused(elsewhere)} is in another project, so it does not supersede ${name}'s hold`,
  );
  assert.equal(said(9), `Cleared. ${name} is now with-mate.`);

  const { entries } = await fleet.cardd.thread(stale.id);
  assert.ok(!entries.some((entry) => entry.kind === "answer"));
  assert.equal(entries.filter((entry) => entry.kind === "release").length, 1);
  const retired = entries.find((entry) => entry.kind === "release");
  assert.equal(retired?.author, "mate:main");
  assert.equal(retired.fields["retired"], true);
  assert.equal(retired.fields["supersededBy"], SUPERSEDING_PR);
  assert.match(retired.body, /^Retired as obsolete, not approved or decided\. /);
  assert.match(retired.body, /PR 420 replaced it\./);
  assert.deepEqual((await fleet.cardd.board()).holds, []);
});

test("the same hold is refused while its worker is still live and waiting on the decision, and retires once the worker's attempt has ended", async () => {
  const cleo = await fleet.cardd.connect(fleet.cardd.addLane("cleo", "main"));
  const live = await staleDecision(cleo, "Review the apply of PR 418");
  await finishedWithPr(cleo, "Apply PR 420", SUPERSEDING_PR);
  h.onModel(() => retire(live, { supersededBy: SUPERSEDING_PR }));
  h.onModel(() => {
    fleet.cardd.endAttemptsByHand(live.id);
    return retire(live, { supersededBy: SUPERSEDING_PR });
  });
  const results = await runMain(2);
  assert.equal(
    results[0],
    `${refused(live)}'s worker is still live and waiting on this decision, so it is not obsolete: answer it, hold it again, or stop the worker first`,
  );
  assert.equal(results[1], `Cleared. ${refused(live)} is now with-mate.`);
  assert.deepEqual((await fleet.cardd.board()).holds, []);
});

test("a merge question, unfinished work that has not landed, and any choice or note beside retire are refused", async () => {
  const cleo = await fleet.cardd.connect(fleet.cardd.addLane("cleo", "main"));
  const stale = await staleDecision(cleo, "Review the apply of PR 417");
  fleet.cardd.endAttemptsByHand(stale.id);
  const superseding = await finishedWithPr(cleo, "Apply PR 420", SUPERSEDING_PR);
  const merging = await finishedWithPr(cleo, "Ship the docs", "https://github.com/acme/web/pull/9");
  const unlanded = await newCard(cleo, "Preserved branch");
  const unlandedWorker = await fleet.cardd.connect(await begin(cleo, unlanded));
  await cleo.call("hold", { card: unlanded.id, question: "Which host?", options: OPTIONS });
  await unlandedWorker.call("report", {
    status: "done",
    text: "PR ready",
    pr: "https://github.com/acme/web/pull/11",
  });
  await cleo.call("hold", { card: unlanded.id, question: "Keep or discard it?", options: OPTIONS });

  h.onModel(() => retire(stale, { supersededBy: superseding.id, choice: "Approve the apply" }));
  h.onModel(() => retire(stale, { supersededBy: superseding.id, note: "Approved." }));
  h.onModel(() => retire(merging, { supersededBy: superseding.id }));
  h.onModel(() => retire(unlanded, { supersededBy: superseding.id }));
  const results = await runMain(4);

  assert.match(results[0] ?? "", /retiring a hold picks no option and records no approval/);
  assert.match(
    results[1] ?? "",
    /exactly one of the captain's exact words, your own note, or retire/,
  );
  assert.match(results[2] ?? "", /merge question: only the captain's approval answers it/);
  assert.match(results[3] ?? "", /stays the captain's call: it cannot be retired/);
  assert.equal(await status(cleo, merging), "with-mate");
  assert.equal(await status(cleo, unlanded), "with-mate");
  const mergeThread = (await fleet.cardd.thread(merging.id)).entries;
  assert.ok(mergeThread.some((entry) => entry.kind === "hold" && entry.fields["merge"] === true));
  assert.ok(!mergeThread.some((entry) => entry.kind === "release" || entry.kind === "answer"));
  assert.deepEqual(
    (await fleet.cardd.board()).holds.map((hold) => hold.card),
    [stale.id],
  );
});

test("a second mate cannot tell another lane's card or PR from a missing one, and retires its own hold with its own work", async () => {
  const cleo = await fleet.cardd.connect(fleet.cardd.addLane("cleo", "main"));
  const dan = await fleet.cardd.connect(fleet.cardd.addLane("dan", "main"));
  const own = await newCard(cleo, "Own hold");
  await cleo.call("hold", { card: own.id, question: "Wait on main?", options: OPTIONS });
  const hidden = await finishedWithPr(dan, "Dan's apply", HIDDEN_PR);
  const superseding = await finishedWithPr(cleo, "Apply PR 420", SUPERSEDING_PR);

  const probe = (supersededBy: number | string) =>
    cleo.call("release", { card: own.id, retire: { reason: WHY, supersededBy } });
  const noCard = (n: number): { message: string } => ({ message: `no card c-${String(n)}` });
  const noPr = (pr: string): { message: string } => ({
    message: `no card has recorded ${pr}, so it supersedes nothing`,
  });
  await assert.rejects(probe(9999), noCard(9999));
  await assert.rejects(probe(hidden.id), noCard(hidden.id));
  await assert.rejects(probe(UNRECORDED_PR), noPr(UNRECORDED_PR));
  await assert.rejects(probe(HIDDEN_PR), noPr(HIDDEN_PR));
  await probe(superseding.id);
  const retired = (await fleet.cardd.thread(own.id)).entries.find(
    (entry) => entry.fields["retired"] === true,
  );
  assert.equal(retired?.author, "mate:cleo");
});
