import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { test } from "node:test";
import { check, OPS } from "@fleet/protocol";
import { begin, newCard, startFleet } from "../support/fleet.ts";
import { Site } from "../support/public-host.ts";
import {
  post,
  reviewSource,
  secondSource,
  takeoverOf,
  verdictOf,
  viaEdge,
} from "../support/review-source-lab.ts";

const first = "http://reviews.example.test:7331";
const second = "http://reviews-alias.example.test:7331";

async function aliasFleet(t: TestContext, key: string, mapping: string) {
  const site = await Site.start();
  t.after(() => site.issuer.stop());
  const { cardd, main, mainToken } = await startFleet(
    { ...site.env, CARDD_REVIEW_ORIGINS: mapping },
    site.flags,
  );
  t.after(() => cardd.stop());
  const card = await newCard(main, "Remap", "scout");
  const token = await begin(main, card);
  const worker = await cardd.connect(token);
  const links = [`${first}/session/${key}`, `${second}/session/${key}`];
  await worker.call("report", {
    status: "needs-decision",
    key: "review-remap",
    text: `Ready: ${links.join(" ")}`,
  });
  const hold = (question?: string, review?: string) =>
    main.call("hold", {
      card: card.id,
      to: "captain",
      question: question ?? "review-remap",
      ...(review === undefined ? {} : { review }),
    });
  return { cardd, main, mainToken, card, token, worker, links, hold };
}

async function restartWith(
  lab: { cardd: Awaited<ReturnType<typeof aliasFleet>>["cardd"] },
  worker: { close: () => Promise<void> },
  mapping: string,
) {
  await worker.close();
  await lab.cardd.stop();
  lab.cardd.env["CARDD_REVIEW_ORIGINS"] = mapping;
  await lab.cardd.restart();
}

test("a link moved to another upstream is not continuous with the old confirmed takeover", async (t) => {
  const { origin, key, file } = await reviewSource(t);
  const other = await secondSource(t, file, undefined);
  const { edge, upstream } = await viaEdge(t, origin);
  const lab = await aliasFleet(t, key, `${first}=${upstream} ${second}=${other.origin}`);
  await lab.hold("review-remap", lab.links[0]);
  const notice = await lab.worker.waitForEntry(
    (entry) => entry.fields["fleetReview"] === true,
    "the first takeover notice",
  );
  await lab.worker.call("report", { status: "working", text: "The notice reached my inbox" });
  await lab.hold("review-remap moved", lab.links[1]);
  const probe = edge.hold("/layout-warnings");
  await restartWith(lab, lab.worker, `${first}=${upstream} ${second}=${upstream}`);
  const again = await lab.cardd.connect(lab.token);
  const mate = await lab.cardd.connect(lab.mainToken);
  await probe.arrived;
  assert.equal(await takeoverOf(mate, lab.card), undefined);
  await post(origin, `/api/${key}/prompts`, verdictOf("Sent before the new takeover"));
  probe.release();
  const renewed = await again.waitForEntry(
    (entry) => entry.fields["fleetReview"] === true && entry.id > notice.id,
    "a new takeover notice",
  );
  assert.equal(await takeoverOf(mate, lab.card), renewed.id);
  await post(origin, `/api/${key}/prompts`, verdictOf("Sent after the new takeover"));
  await again.waitForEntry(
    (entry) => entry.kind === "review-feedback" && entry.body === "Sent after the new takeover",
    "the verdict sent after the new takeover",
  );
  assert.deepEqual(
    again.entries
      .filter(({ entry }) => entry.kind === "review-feedback")
      .map(({ entry }) => entry.body),
    ["Sent after the new takeover"],
  );
});

test("a wording edit after a confirmed remap keeps the takeover through a later alias retirement", async (t) => {
  const { origin, key, file } = await reviewSource(t);
  const other = await secondSource(t, file, key);
  const lab = await aliasFleet(t, key, `${first}=${origin.origin} ${second}=${other.origin}`);
  await lab.hold("review-remap", lab.links[0]);
  const firstNotice = await lab.worker.waitForEntry(
    (entry) => entry.fields["fleetReview"] === true,
    "the first takeover notice",
  );
  await restartWith(lab, lab.worker, `${first}=${other.origin} ${second}=${other.origin}`);
  const remapped = await lab.cardd.connect(lab.token);
  const moved = await remapped.waitForEntry(
    (entry) =>
      entry.fields["fleetReview"] === true &&
      entry.fields["upstream"] === `${other.origin}/session/${key}`,
    "the takeover notice on the remapped upstream",
  );
  assert.ok(moved.id > firstNotice.id);
  const mate = await lab.cardd.connect(lab.mainToken);
  const edit = (review?: string) =>
    mate.call("hold", {
      card: lab.card.id,
      to: "captain",
      question: "review-remap edited",
      ...(review === undefined ? {} : { review }),
    });
  await edit();
  await edit(lab.links[1]);
  await remapped.call("report", { status: "working", text: "The notice reached my inbox" });
  await restartWith(lab, remapped, `${second}=${other.origin}`);
  await post(other, `/api/${key}/prompts`, verdictOf("Sent while cardd was down"));
  const again = await lab.cardd.connect(lab.token);
  await again.waitForEntry(
    (entry) => entry.kind === "review-feedback" && entry.body === "Sent while cardd was down",
    "the verdict sent while cardd was down",
  );
  const reader = await lab.cardd.connect(lab.mainToken);
  assert.equal(await takeoverOf(reader, lab.card), moved.id);
  const { entries } = check(OPS.card.result, await reader.call("card", { card: lab.card.id }));
  assert.equal(entries.filter((entry) => entry.fields["fleetReview"] === true).length, 2);
});
