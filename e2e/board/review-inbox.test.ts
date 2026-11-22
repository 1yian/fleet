import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { check, OPS } from "@fleet/protocol";
import { begin, newCard, startFleet, status } from "../support/fleet.ts";
import { Lavish } from "../support/lavish.ts";
import { Site } from "../support/public-host.ts";
import { tempDir } from "../support/run-root.ts";

async function post(origin: URL, path: string, body: object): Promise<unknown> {
  const response = await fetch(new URL(path, origin), {
    method: "POST",
    headers: { "content-type": "application/json", origin: origin.origin },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return JSON.parse(text);
}

async function reviewSource(t: TestContext) {
  const dir = tempDir("fleet-review-inbox-");
  const lavish = await Lavish.start(dir);
  t.after(() => lavish.stop());
  const origin = new URL(`http://127.0.0.1:${lavish.env["LAVISH_AXI_PORT"] ?? ""}`);
  const file = join(dir, "draft.html");
  writeFileSync(file, "<!doctype html><h1>Draft for review</h1>");
  const opened = await post(origin, "/api/sessions", { file });
  assert.ok(typeof opened === "object" && opened !== null && "key" in opened);
  assert.equal(typeof opened.key, "string");
  const key = String(opened.key);
  return { origin, key };
}

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
    assert.ok(typeof queued === "object" && queued !== null && "status" in queued);
    assert.equal(queued.status, "queued");
    const feedback = await worker.waitForEntry(
      (entry) => entry.kind === "review-feedback" && entry.body.includes(round.submit),
      `Lavish feedback for ${reviewKey}`,
    );
    assert.equal(feedback.author, "lavish");
    assert.deepEqual(feedback.fields["reviewKeys"], [reviewKey]);
    assert.equal(feedback.fields["sessionEnded"], round.end);
    assert.equal(feedback.body, `${round.verdict}\n\n${round.submit}`);
    assert.equal(await status(main, card), "needs-you");
    const hold = (await view()).hold;
    assert.ok(hold);
    assert.equal(hold.entry, feedback.fields["round"]);
    const next = rounds[index + 1];
    if (next !== undefined && next.reviewKey !== reviewKey) {
      assert.equal(
        await cardd.act(card.id, {
          kind: "answer",
          hold: hold.entry,
          choice: round.submit,
          written: true,
        }),
        200,
      );
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
    [["review-1"], ["review-1"], ["review-2"], ["review-3"]],
  );
  assert.deepEqual(
    worker.entries
      .filter(({ entry }) => entry.kind === "review-feedback")
      .map(({ entry }) => entry.id),
    receipts.map(({ id }) => id),
  );
});
