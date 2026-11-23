import assert from "node:assert/strict";
import { test } from "node:test";
import { check, OPS, type Entry } from "@fleet/protocol";
import type { Cardd } from "../support/cardd.ts";
import { begin, newCard, startFleet, status } from "../support/fleet.ts";
import { Site } from "../support/public-host.ts";
import {
  handOffKey,
  labFor,
  post,
  reviewSource,
  takeoverOf,
  verdictOf,
  viaEdge,
} from "../support/review-source-lab.ts";

const rounds = [
  {
    reviewKey: "review-1",
    verdict: "Keep reviews private",
    submit: "Incorporate the verdict and send the next round",
    end: false,
  },
  {
    reviewKey: "review-1",
    verdict: "Keep verdicts verbatim",
    submit: "One more note on the current round",
    end: false,
  },
  {
    reviewKey: "review-2",
    verdict: "Approve the revised draft",
    submit: "Final draft decision",
    end: false,
  },
  {
    reviewKey: "review-3",
    verdict: "Keep the change log",
    submit: "Final notes and end",
    end: true,
  },
];

async function assertTakeoverNotesPrivate(
  cardd: Cardd,
  card: number,
  upstream: string,
  seen: readonly Entry[],
): Promise<void> {
  const board = await cardd.thread(card);
  const shown = JSON.stringify(board);
  assert.ok(!shown.includes(upstream));
  assert.ok(!shown.includes("fleetReview"));
  assert.ok(!shown.includes("review-feedback"));
  const notes = seen.filter(
    (entry) => entry.author === "fleet" && entry.fields["fleetReview"] === true,
  );
  assert.equal(notes.length, 3);
  assert.ok(board.entries.some((entry) => entry.kind === "hold"));
  assert.ok(board.entries.every((entry) => !notes.some(({ id }) => id === entry.id)));
}

test("successive stock Lavish submissions reach the Fleet worker inbox once per review key", async (t) => {
  const { origin, key } = await reviewSource(t);
  const site = await Site.start();
  t.after(() => site.issuer.stop());
  const reported = "http://reviews.example.test:7331";
  const review = `${reported}/session/${key}`;
  const { cardd, main } = await startFleet(
    { ...site.env, CARDD_REVIEW_ORIGINS: `${reported}=${origin.origin}` },
    site.flags,
  );
  t.after(() => cardd.stop());
  const card = await newCard(main, "Review the vision", "scout");
  const worker = await cardd.connect(await begin(main, card));
  const unmapped = await newCard(main, "Unmapped review", "scout");
  const other = await cardd.connect(await begin(main, unmapped));
  const otherUrl = `http://unmapped.example.test/session/${key}`;
  await other.call("report", {
    status: "needs-decision",
    key: "review-unmapped",
    text: `Ready: ${otherUrl}`,
  });
  await main.call("hold", {
    card: unmapped.id,
    to: "captain",
    question: "Unmapped",
    review: otherUrl,
  });
  const view = async () => check(OPS.card.result, await main.call("card", { card: card.id }));
  const bind = async (reviewKey: string) => {
    await worker.call("report", {
      status: "needs-decision",
      key: reviewKey,
      text: `Ready: ${review}`,
    });
    await main.call("hold", { card: card.id, to: "captain", question: reviewKey, review });
    await worker.waitForEntry(
      (entry) => entry.fields["fleetReview"] === true && entry.body === reviewKey,
      `Fleet ownership of ${reviewKey}`,
    );
  };
  for (const [index, round] of rounds.entries()) {
    const { reviewKey } = round;
    if (rounds[index - 1]?.reviewKey !== reviewKey) await bind(reviewKey);
    const queued = await post(origin, `/api/${key}/prompts`, {
      prompts: [
        { uid: "1", tag: "vision-verdict", prompt: round.verdict, selector: "#verdict" },
        { uid: "2", tag: "vision-verdict", prompt: round.submit, selector: "#submit" },
      ],
      endSession: round.end,
    });
    assert.deepEqual(Reflect.get(Object(queued), "status"), "queued");
    const feedback = await worker.waitForEntry(
      (entry) => entry.kind === "review-feedback" && entry.body.includes(round.submit),
      `Lavish feedback for ${reviewKey}`,
    );
    assert.equal(feedback.author, "lavish");
    assert.deepEqual(feedback.fields["reviewKeys"], [reviewKey]);
    assert.equal(feedback.fields["sessionEnded"], round.end ? null : false);
    assert.equal(feedback.body, `${round.verdict}\n\n${round.submit}`);
    assert.equal(await status(main, card), "needs-you");
    const hold = (await view()).hold;
    assert.ok(hold);
    assert.equal(hold.entry, feedback.fields["round"]);
    const next = rounds[index + 1];
    if (next !== undefined && next.reviewKey !== reviewKey) {
      await handOffKey({ cardd, mate: main, worker }, card, hold.entry, reviewKey);
    }
  }
  assert.equal(await status(main, unmapped), "needs-you");
  assert.deepEqual(
    other.entries.filter(
      ({ entry }) => entry.fields["fleetReview"] === true || entry.kind === "review-feedback",
    ),
    [],
  );
  const { entries } = await view();
  const receipts = entries.filter((entry) => entry.kind === "review-feedback");
  assert.deepEqual(
    receipts.map((entry) => entry.fields["reviewKeys"]),
    [["review-1"], ["review-1"], ["review-2"], ["review-3"], ["review-3"]],
  );
  assert.deepEqual(
    receipts.filter((entry) => entry.fields["sessionEnded"] === true).map((entry) => entry.body),
    [""],
  );
  assert.deepEqual(
    worker.entries
      .filter(({ entry }) => entry.kind === "review-feedback")
      .map(({ entry }) => entry.id),
    receipts.map(({ id }) => id),
  );
  await assertTakeoverNotesPrivate(cardd, card.id, origin.origin, (await view()).entries);
});

test("an empty Send & End is one live session end that a later round never inherits", async (t) => {
  const { origin, key } = await reviewSource(t);
  const { cardd, main, card, token, bind } = await labFor(t, key, origin.origin, "Empty end");
  const worker = await cardd.connect(token);
  await bind(worker, "review-empty");
  await worker.waitForEntry(
    (entry) => entry.fields["fleetReview"] === true && entry.body === "review-empty",
    "Fleet ownership of review-empty",
  );
  await post(origin, `/api/${key}/prompts`, { prompts: [], endSession: true });
  const ended = await worker.waitForEntry(
    (entry) => entry.kind === "review-feedback",
    "the session end",
  );
  assert.equal(ended.author, "lavish");
  assert.equal(ended.body, "");
  assert.deepEqual(ended.fields["reviewKeys"], ["review-empty"]);
  assert.equal(ended.fields["sessionEnded"], true);
  assert.deepEqual(ended.fields["sourcePrompts"], []);
  const view = async () => check(OPS.card.result, await main.call("card", { card: card.id }));
  const hold = (await view()).hold;
  assert.ok(hold);
  assert.equal(
    await cardd.act(card.id, {
      kind: "answer",
      hold: hold.entry,
      choice: "Continue",
      written: true,
    }),
    200,
  );
  await bind(worker, "review-after");
  await worker.waitForEntry(
    (entry) => entry.fields["fleetReview"] === true && entry.body === "review-after",
    "Fleet ownership of review-after on the already ended session",
  );
  const receipts = (await view()).entries.filter((entry) => entry.kind === "review-feedback");
  assert.equal(receipts.length, 1);
  assert.deepEqual(receipts[0]?.fields["reviewKeys"], ["review-empty"]);
});

test("a verdict replayed after a reconnect does not inherit a later session end", async (t) => {
  const { origin, key } = await reviewSource(t);
  const { cardd, mainToken, card, token, bind } = await labFor(t, key, origin.origin, "Replay");
  const worker = await cardd.connect(token);
  await bind(worker, "review-replay");
  await worker.waitForEntry(
    (entry) => entry.fields["fleetReview"] === true,
    "Fleet ownership of review-replay",
  );
  await worker.close();
  await cardd.stop();
  await post(origin, `/api/${key}/prompts`, {
    prompts: [{ uid: "1", tag: "verdict", prompt: "Keep it open", selector: "#v" }],
    endSession: false,
  });
  await post(origin, `/api/${key}/end`, {});
  await cardd.restart();
  const again = await cardd.connect(token);
  const verdict = await again.waitForEntry(
    (entry) => entry.kind === "review-feedback" && entry.body === "Keep it open",
    "the replayed verdict",
  );
  assert.equal(verdict.fields["sessionEnded"], null);
  const mate = await cardd.connect(mainToken);
  const { entries } = check(OPS.card.result, await mate.call("card", { card: card.id }));
  assert.equal(await status(mate, card), "needs-you");
  assert.equal(entries.filter((entry) => entry.kind === "review-feedback").length, 1);
});

test("feedback sent before the takeover notice is not forwarded and later feedback is", async (t) => {
  const { origin, key } = await reviewSource(t);
  const { edge, upstream } = await viaEdge(t, origin);
  const probe = edge.hold("/layout-warnings");
  const { cardd, main, card, token, bind } = await labFor(t, key, upstream, "Fence");
  const worker = await cardd.connect(token);
  await bind(worker, "review-fence");
  await probe.arrived;
  assert.equal(await takeoverOf(main, card), undefined);
  const delivered = edge.frameSeen("/events/", "Sent before the notice");
  await post(origin, `/api/${key}/prompts`, verdictOf("Sent before the notice"));
  await delivered;
  probe.release();
  const notice = await worker.waitForEntry(
    (entry) => entry.fields["fleetReview"] === true && entry.body === "review-fence",
    "the takeover notice",
  );
  assert.equal(await takeoverOf(main, card), notice.id);
  await post(origin, `/api/${key}/prompts`, verdictOf("Sent after the notice"));
  await worker.waitForEntry(
    (entry) => entry.kind === "review-feedback" && entry.body === "Sent after the notice",
    "the verdict sent after the notice",
  );
  assert.deepEqual(
    worker.entries
      .filter(({ entry }) => entry.kind === "review-feedback")
      .map(({ entry }) => entry.body),
    ["Sent after the notice"],
  );
});

test("a mapped link with no stock session is never taken over", async (t) => {
  const { origin, key } = await reviewSource(t);
  const { edge, upstream } = await viaEdge(t, origin);
  const { cardd, main, card, token, bind } = await labFor(t, key, upstream, "Missing");
  const worker = await cardd.connect(token);
  const missing = "0".repeat(16);
  const dropped = edge.tunnelClosed(`/events/${missing}`);
  await bind(worker, "review-missing", `http://reviews.example.test:7331/session/${missing}`);
  const second = await newCard(main, "Present", "scout");
  const present = await cardd.connect(await begin(main, second));
  await present.call("report", {
    status: "needs-decision",
    key: "review-present",
    text: `Ready: http://reviews.example.test:7331/session/${key}`,
  });
  await main.call("hold", {
    card: second.id,
    to: "captain",
    question: "review-present",
    review: `http://reviews.example.test:7331/session/${key}`,
  });
  await present.waitForEntry(
    (entry) => entry.fields["fleetReview"] === true,
    "Fleet ownership of the present session",
  );
  await dropped;
  assert.deepEqual(
    worker.entries.filter(
      ({ entry }) => entry.fields["fleetReview"] === true || entry.kind === "review-feedback",
    ),
    [],
  );
  assert.equal(await status(main, card), "needs-you");
});
