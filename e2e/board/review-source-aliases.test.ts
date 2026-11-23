import assert from "node:assert/strict";
import { test } from "node:test";
import { check, OPS } from "@fleet/protocol";
import { begin, newCard, startFleet } from "../support/fleet.ts";
import { Site } from "../support/public-host.ts";
import { post, reviewSource, takeoverOf, verdictOf } from "../support/review-source-lab.ts";

test("a link that resolves to the same upstream keeps the current takeover", async (t) => {
  const { origin, key } = await reviewSource(t);
  const site = await Site.start();
  t.after(() => site.issuer.stop());
  const first = "http://reviews.example.test:7331";
  const second = "http://reviews-alias.example.test:7331";
  const { cardd, main, mainToken } = await startFleet(
    {
      ...site.env,
      CARDD_REVIEW_ORIGINS: `${first}=${origin.origin} ${second}=${origin.origin}`,
    },
    site.flags,
  );
  t.after(() => cardd.stop());
  const card = await newCard(main, "Alias", "scout");
  const worker = await cardd.connect(await begin(main, card));
  const links = [`${first}/session/${key}`, `${second}/session/${key}`];
  await worker.call("report", {
    status: "needs-decision",
    key: "review-alias",
    text: `Ready: ${links.join(" ")}`,
  });
  await main.call("hold", {
    card: card.id,
    to: "captain",
    question: "review-alias",
    review: links[0],
  });
  const notice = await worker.waitForEntry(
    (entry) => entry.fields["fleetReview"] === true,
    "the takeover notice",
  );
  assert.equal(await takeoverOf(main, card), notice.id);
  await main.call("hold", {
    card: card.id,
    to: "captain",
    question: "review-alias again",
    review: links[1],
  });
  assert.equal(await takeoverOf(main, card), notice.id);
  await post(origin, `/api/${key}/prompts`, verdictOf("Sent through the alias"));
  await worker.waitForEntry(
    (entry) => entry.kind === "review-feedback" && entry.body === "Sent through the alias",
    "the verdict after the alias edit",
  );
  assert.equal(await takeoverOf(await cardd.connect(mainToken), card), notice.id);
});

test("a restart after the first alias is retired keeps the confirmed takeover", async (t) => {
  const { origin, key } = await reviewSource(t);
  const site = await Site.start();
  t.after(() => site.issuer.stop());
  const first = "http://reviews.example.test:7331";
  const second = "http://reviews-alias.example.test:7331";
  const { cardd, main, mainToken } = await startFleet(
    {
      ...site.env,
      CARDD_REVIEW_ORIGINS: `${first}=${origin.origin} ${second}=${origin.origin}`,
    },
    site.flags,
  );
  t.after(() => cardd.stop());
  const card = await newCard(main, "Retired alias", "scout");
  const token = await begin(main, card);
  const worker = await cardd.connect(token);
  const links = [`${first}/session/${key}`, `${second}/session/${key}`];
  await worker.call("report", {
    status: "needs-decision",
    key: "review-retired",
    text: `Ready: ${links.join(" ")}`,
  });
  await main.call("hold", {
    card: card.id,
    to: "captain",
    question: "review-retired",
    review: links[0],
  });
  const notice = await worker.waitForEntry(
    (entry) => entry.fields["fleetReview"] === true,
    "the takeover notice",
  );
  await worker.call("report", { status: "working", text: "The notice reached my inbox" });
  await main.call("hold", {
    card: card.id,
    to: "captain",
    question: "review-retired again",
    review: links[1],
  });
  await worker.close();
  await cardd.stop();
  await post(origin, `/api/${key}/prompts`, verdictOf("Sent while cardd was down"));
  cardd.env["CARDD_REVIEW_ORIGINS"] = `${second}=${origin.origin}`;
  await cardd.restart();
  const again = await cardd.connect(token);
  await again.waitForEntry(
    (entry) => entry.kind === "review-feedback" && entry.body === "Sent while cardd was down",
    "the verdict sent while cardd was down",
  );
  const mate = await cardd.connect(mainToken);
  assert.equal(await takeoverOf(mate, card), notice.id);
  const { entries } = check(OPS.card.result, await mate.call("card", { card: card.id }));
  assert.equal(entries.filter((entry) => entry.fields["fleetReview"] === true).length, 1);
});
