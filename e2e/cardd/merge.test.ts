// Grants, merge approvals, the guarded merge, and PR state (spec sections 7.5,
// 13.1, 18, and 20.4), against a real cardd and a fake gh.
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { MERGE_OPTIONS, type Card } from "@fleet/protocol";
import type { Session } from "../support/cardd.ts";
import { begin, newCard, startFleet, status, type Fleet } from "../support/fleet.ts";
import { FakeGitHub } from "../support/github.ts";

const PR = "https://github.com/acme/web/pull/7";
const [APPROVE, CHANGES] = MERGE_OPTIONS;

let fleet: Fleet;
let gh: FakeGitHub;
beforeEach(async () => {
  gh = new FakeGitHub();
  fleet = await startFleet({ CARDD_TIMING_SCALE: "0.001", ...gh.env });
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
  fleet.main.call("answer", { card: card.id, words: "yes, merge it", source: "chat", choice });
const merge = (card: Card) => fleet.main.call("merge", { card: card.id });
const grant = (project: string) =>
  fleet.main.call("grant", {
    lane: "main",
    project,
    words: "You may merge web when CI is green",
    source: "chat",
    may: "merge when CI is green",
    merge: true,
  });

test("a done ship card asks the captain; approval, the merge, and the merged notice follow", async () => {
  gh.setPr(PR, "OPEN", { ci: "pass" });
  const card = await newCard(fleet.main, "Users see one scrollbar");
  await done(card);
  assert.equal(await status(fleet.main, card), "needs-you");
  await assert.rejects(approve(card, "sure"), {
    message: `a merge question needs the choice "${APPROVE}" or "${CHANGES}"`,
  });

  await approve(card);
  assert.equal(await status(fleet.main, card), "merging");
  await merge(card);
  assert.equal(gh.state(PR), "MERGED");
  const notice = await fleet.main.waitForEntry(
    (entry) => entry.fields["condition"] === "pr-merged",
    "the notice",
  );
  assert.equal(notice.body, "PR merged; run cleanup");
});

test("request changes sends the card back to the worker", async () => {
  gh.setPr(PR, "OPEN", { ci: "pass" });
  const card = await newCard(fleet.main, "Users see one scrollbar");
  await done(card);
  await approve(card, CHANGES);
  assert.equal(await status(fleet.main, card), "working");
});

test("a lane grant for merging sends a done card to Merging, but only in its project", async () => {
  gh.setPr(PR, "OPEN", { ci: "pass" });
  fleet.cardd.addProject("api", 1, { maverick: "/clones/api" });
  await grant("api");
  const outside = await newCard(fleet.main, "outside the grant");
  await done(outside);
  assert.equal(await status(fleet.main, outside), "needs-you");

  await grant("web");
  const inside = await newCard(fleet.main, "inside the grant");
  await done(inside, "https://github.com/acme/web/pull/8");
  assert.equal(await status(fleet.main, inside), "merging");
});

test("merge refuses without authority, and refuses red or pending checks", async () => {
  gh.setPr(PR, "OPEN", { ci: "fail" });
  const card = await newCard(fleet.main, "Users see one scrollbar");
  await done(card);
  await assert.rejects(merge(card), {
    message: `no authority to merge c-${String(card.id)}: it needs a grant or the captain's approval`,
  });
  const quoted = () =>
    fleet.main.call("merge", { card: card.id, words: "merge it", source: "chat" });
  await assert.rejects(quoted(), { message: "checks failed: ci" });
  gh.setPr(PR, "OPEN", { ci: "pending" });
  await assert.rejects(quoted(), { message: "checks have not reported yet: ci" });
  assert.equal(gh.state(PR), "OPEN");
});

test("quoted words merge only on a card with an open merge question, and they answer it", async () => {
  gh.setPr(PR, "OPEN", { ci: "pass" });
  const blocked = await newCard(fleet.main, "unrelated question");
  const blockedWorker = await fleet.cardd.connect(await begin(fleet.main, blocked));
  await blockedWorker.call("report", { status: "blocked", text: "stuck", pr: PR });
  await fleet.main.call("ask", { card: blocked.id, question: "Which way?", options: ["a", "b"] });
  assert.equal(await status(fleet.main, blocked), "needs-you");
  const quoted = (card: Card) =>
    fleet.main.call("merge", { card: card.id, words: "merge it", source: "chat" });
  await assert.rejects(quoted(blocked), {
    message: `no authority to merge c-${String(blocked.id)}: it needs a grant or the captain's approval`,
  });
  assert.equal(gh.state(PR), "OPEN");

  const card = await newCard(fleet.main, "Users see one scrollbar");
  await done(card, "https://github.com/acme/web/pull/11");
  gh.setPr("https://github.com/acme/web/pull/11", "OPEN", { ci: "pass" });
  await quoted(card);
  assert.equal(gh.state("https://github.com/acme/web/pull/11"), "MERGED");
  assert.equal(await status(fleet.main, card), "merging");
  await assert.rejects(approve(card), { message: `c-${String(card.id)} has no open question` });
});

test("a second done report does not add a second merge question", async () => {
  gh.setPr(PR, "OPEN", { ci: "pass" });
  const card = await newCard(fleet.main, "Users see one scrollbar");
  const worker = await done(card);
  await worker.call("report", { status: "done", text: "still green", pr: PR });
  await approve(card);
  await assert.rejects(approve(card), { message: `c-${String(card.id)} has no open question` });
});

test("merge does not run when gh cannot read the checks", async () => {
  gh.setPr(PR, "OPEN", { ci: "pass" });
  const card = await newCard(fleet.main, "Users see one scrollbar");
  await done(card);
  gh.breakChecks(PR);
  await assert.rejects(
    fleet.main.call("merge", { card: card.id, words: "merge it", source: "chat" }),
    /gh pr checks .* failed: HTTP 502/,
  );
  assert.equal(gh.state(PR), "OPEN");
});

test("a PR with no checks reported merges", async () => {
  gh.setPr(PR, "OPEN");
  const card = await newCard(fleet.main, "Users see one scrollbar");
  await done(card);
  await fleet.main.call("merge", { card: card.id, words: "merge it", source: "chat" });
  assert.equal(gh.state(PR), "MERGED");
});

test("a closed PR, and red checks while Merging, go back to the mate", async () => {
  gh.setPr(PR, "CLOSED");
  const closed = await newCard(fleet.main, "closed");
  await done(closed);
  const red = "https://github.com/acme/web/pull/9";
  gh.setPr(red, "OPEN", { ci: "pass" });
  const merging = await newCard(fleet.main, "red while merging");
  await done(merging, red);
  await approve(merging);
  gh.setPr(red, "OPEN", { ci: "fail" });

  await fleet.main.waitForEntry(
    (entry) => entry.fields["condition"] === "pr-closed",
    "the closed PR",
  );
  await fleet.main.waitForEntry(
    (entry) => entry.fields["condition"] === "checks-failed",
    "the red checks",
  );
  assert.deepEqual(
    [await status(fleet.main, closed), await status(fleet.main, merging)],
    ["with-mate", "with-mate"],
  );
});

test("a gh read that fails for one pass does not repeat a PR notice", async () => {
  gh.setPr(PR, "OPEN", { ci: "pass" });
  const card = await newCard(fleet.main, "Users see one scrollbar");
  await done(card);
  await approve(card);
  await merge(card);
  await fleet.main.waitForEntry(
    (entry) => entry.card === card.id && entry.fields["condition"] === "pr-merged",
    "the notice",
  );

  const afterPasses = async (what: string): Promise<void> => {
    for (const round of [1, 2]) {
      const probe = await newCard(fleet.main, `${what} ${String(round)}`);
      await fleet.main.call("hold", { card: probe.id, until: Date.now() + 100, reason: "probe" });
      await fleet.main.waitForEntry(
        (entry) =>
          entry.card === probe.id && String(entry.fields["condition"]).startsWith("hold-ended:"),
        `a check pass ${what}`,
      );
    }
  };
  gh.setDown(PR, true);
  await afterPasses("while gh is down");
  gh.setDown(PR, false);
  await afterPasses("after gh is back");

  const notices = fleet.main.entries.filter(
    ({ entry }) => entry.card === card.id && entry.fields["condition"] === "pr-merged",
  );
  assert.equal(notices.length, 1);
});

test("a second mate's merge approval goes to the captain, and main gets one line", async () => {
  gh.setPr(PR, "OPEN", { ci: "pass" });
  const cleo = await fleet.cardd.connect(fleet.cardd.addLane("cleo", "main"));
  const card = await newCard(cleo, "Ads stay under budget");
  const worker = await fleet.cardd.connect(await begin(cleo, card));
  await worker.call("report", { status: "done", text: "PR green", pr: PR });

  assert.equal(await status(cleo, card), "needs-you");
  const line = await fleet.main.waitForEntry((entry) => entry.kind === "ask", "the merge line");
  assert.equal(line.body, `Merge ${PR} for c-${String(card.id)}: Ads stay under budget?`);
});
