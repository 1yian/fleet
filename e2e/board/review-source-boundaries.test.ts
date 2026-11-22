import assert from "node:assert/strict";
import { test } from "node:test";
import { check, OPS } from "@fleet/protocol";
import { begin, newCard } from "../support/fleet.ts";
import { Lavish } from "../support/lavish.ts";
import { labFor, post, reviewSource, verdictOf } from "../support/review-source-lab.ts";
import { tempDir } from "../support/run-root.ts";

test("a verdict queued before a bind or between rounds never crosses to a new review key", async (t) => {
  const { origin, key } = await reviewSource(t);
  const { cardd, main, card, token, bind } = await labFor(t, key, origin.origin, "Boundary");
  const worker = await cardd.connect(token);
  await post(origin, `/api/${key}/prompts`, verdictOf("Before any bind"));
  await bind(worker, "review-one");
  await worker.waitForEntry((entry) => entry.fields["fleetReview"] === true, "review-one notice");
  await post(origin, `/api/${key}/prompts`, verdictOf("Round one verdict"));
  await worker.waitForEntry(
    (entry) => entry.kind === "review-feedback" && entry.body === "Round one verdict",
    "the round one verdict",
  );
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
  await post(origin, `/api/${key}/prompts`, verdictOf("Late for round one"));
  await bind(worker, "review-two");
  await worker.waitForEntry(
    (entry) => entry.fields["fleetReview"] === true && entry.body === "review-two",
    "review-two notice",
  );
  await post(origin, `/api/${key}/prompts`, verdictOf("Round two verdict"));
  await worker.waitForEntry(
    (entry) => entry.kind === "review-feedback" && entry.body === "Round two verdict",
    "the round two verdict",
  );
  const receipts = (await view()).entries.filter((entry) => entry.kind === "review-feedback");
  assert.deepEqual(
    receipts.map((entry) => [entry.body, entry.fields["reviewKeys"]]),
    [
      ["Round one verdict", ["review-one"]],
      ["Round two verdict", ["review-two"]],
    ],
  );
});

test("repeated End requests are not new ends and an end that cannot be tied to a verdict stays unknown", async (t) => {
  const { origin, key, file } = await reviewSource(t);
  const { cardd, main, card, token, bind } = await labFor(t, key, origin.origin, "Repeat end");
  const worker = await cardd.connect(token);
  await bind(worker, "review-repeat");
  await worker.waitForEntry((entry) => entry.fields["fleetReview"] === true, "the notice");
  await post(origin, `/api/${key}/prompts`, verdictOf("Before the end"));
  await post(origin, `/api/${key}/prompts`, { prompts: [], endSession: true });
  await post(origin, `/api/${key}/end`, {});
  await post(origin, `/api/${key}/end`, {});
  await post(origin, "/api/sessions", { file, reopen: true });
  await post(origin, `/api/${key}/prompts`, verdictOf("Open again"));
  await worker.waitForEntry(
    (entry) => entry.kind === "review-feedback" && entry.body === "Open again",
    "the verdict after reopening",
  );
  const { entries } = check(OPS.card.result, await main.call("card", { card: card.id }));
  const receipts = entries
    .filter((entry) => entry.kind === "review-feedback")
    .map((entry) => [entry.body, entry.fields["sessionEnded"]]);
  assert.deepEqual(receipts, [
    ["Before the end", false],
    ["", true],
    ["Open again", null],
  ]);
});

test("editing only a hold's question keeps its source baseline and listener", async (t) => {
  const { origin, key } = await reviewSource(t);
  const { cardd, main, card, token, bind } = await labFor(t, key, origin.origin, "Edit");
  const worker = await cardd.connect(token);
  await bind(worker, "review-edit");
  await worker.waitForEntry((entry) => entry.fields["fleetReview"] === true, "the notice");
  await main.call("hold", { card: card.id, to: "captain", question: "Edited wording" });
  await post(origin, `/api/${key}/prompts`, verdictOf("Sent right after the edit"));
  await worker.waitForEntry(
    (entry) => entry.kind === "review-feedback" && entry.body === "Sent right after the edit",
    "the verdict sent after the edit",
  );
  const { entries } = check(OPS.card.result, await main.call("card", { card: card.id }));
  assert.deepEqual(
    entries
      .filter((entry) => entry.kind === "review-feedback")
      .map((entry) => [entry.body, entry.fields["reviewKeys"]]),
    [["Sent right after the edit", ["review-edit"]]],
  );
  assert.equal(entries.filter((entry) => entry.fields["fleetReview"] === true).length, 1);
});

test("one stock session is owned by one card at a time and never leaks to the other", async (t) => {
  const { origin, key } = await reviewSource(t);
  const { cardd, main, card, token, review, bind } = await labFor(t, key, origin.origin, "First");
  const first = await cardd.connect(token);
  await bind(first, "review-first");
  await first.waitForEntry((entry) => entry.fields["fleetReview"] === true, "the first notice");
  const other = await newCard(main, "Second", "scout");
  const second = await cardd.connect(await begin(main, other));
  await second.call("report", {
    status: "needs-decision",
    key: "review-second",
    text: `Ready: ${review}`,
  });
  await main.call("hold", { card: other.id, to: "captain", question: "second", review });
  await post(origin, `/api/${key}/prompts`, verdictOf("Meant for the first card"));
  await first.waitForEntry(
    (entry) => entry.kind === "review-feedback" && entry.body === "Meant for the first card",
    "the verdict on the first card",
  );
  const view = async () => check(OPS.card.result, await main.call("card", { card: card.id }));
  const hold = (await view()).hold;
  assert.ok(hold);
  assert.equal(
    await cardd.act(card.id, { kind: "answer", hold: hold.entry, choice: "Done", written: true }),
    200,
  );
  await second.waitForEntry(
    (entry) => entry.fields["fleetReview"] === true,
    "the second card taking over once the first released the session",
  );
  assert.deepEqual(
    second.entries.filter(({ entry }) => entry.kind === "review-feedback"),
    [],
  );
});

test("a replacement upstream behind the same link starts from its own baseline", async (t) => {
  const { origin, key, file } = await reviewSource(t);
  const { cardd, token, reported, bind } = await labFor(t, key, origin.origin, "Remap");
  const worker = await cardd.connect(token);
  await bind(worker, "review-remap");
  await worker.waitForEntry((entry) => entry.fields["fleetReview"] === true, "the notice");
  const dir = tempDir("fleet-review-replacement-");
  const lavish = await Lavish.start(dir);
  t.after(() => lavish.stop());
  const next = new URL(`http://127.0.0.1:${lavish.env["LAVISH_AXI_PORT"] ?? ""}`);
  const opened = await post(next, "/api/sessions", { file });
  assert.ok(typeof opened === "object" && opened !== null && "key" in opened);
  assert.equal(opened.key, key);
  await post(next, `/api/${key}/prompts`, verdictOf("History of the replacement"));
  await worker.close();
  await cardd.stop();
  cardd.env["CARDD_REVIEW_ORIGINS"] = `${reported}=${next.origin}`;
  await cardd.restart();
  const again = await cardd.connect(token);
  await again.waitForEntry(
    (entry) => entry.fields["upstream"] === `${next.origin}/session/${key}`,
    "the notice for the replacement upstream",
  );
  await post(next, `/api/${key}/prompts`, verdictOf("Live on the replacement"));
  await again.waitForEntry(
    (entry) => entry.kind === "review-feedback" && entry.body === "Live on the replacement",
    "the live verdict on the replacement",
  );
  assert.deepEqual(
    again.entries
      .filter(({ entry }) => entry.kind === "review-feedback")
      .map(({ entry }) => entry.body),
    ["Live on the replacement"],
  );
});
