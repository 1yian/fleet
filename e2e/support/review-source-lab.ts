import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TestContext } from "node:test";
import type { Card } from "@fleet/protocol";
import type { Cardd, Session } from "./cardd.ts";
import { begin, newCard, startFleet } from "./fleet.ts";
import { Lavish } from "./lavish.ts";
import { Edge, Site } from "./public-host.ts";
import { tempDir } from "./run-root.ts";

export async function post(origin: URL, path: string, body: object): Promise<unknown> {
  const response = await fetch(new URL(path, origin), {
    method: "POST",
    headers: { "content-type": "application/json", origin: origin.origin },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return JSON.parse(text);
}

export async function reviewSource(t: TestContext) {
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
  const spare = join(dir, "spare.html");
  writeFileSync(spare, "<!doctype html><h1>Spare</h1>");
  await post(origin, "/api/sessions", { file: spare });
  return { origin, key, file };
}

export async function labFor(t: TestContext, key: string, upstream: string, title: string) {
  const site = await Site.start();
  t.after(() => site.issuer.stop());
  const reported = "http://reviews.example.test:7331";
  const { cardd, main, mainToken } = await startFleet(
    { ...site.env, CARDD_REVIEW_ORIGINS: `${reported}=${upstream}` },
    site.flags,
  );
  t.after(() => cardd.stop());
  const card = await newCard(main, title, "scout");
  const token = await begin(main, card);
  const review = `${reported}/session/${key}`;
  const bind = async (worker: Session, reviewKey: string, link = review) => {
    await worker.call("report", {
      status: "needs-decision",
      key: reviewKey,
      text: `Ready: ${link}`,
    });
    await main.call("hold", { card: card.id, to: "captain", question: reviewKey, review: link });
  };
  return { cardd, main, mainToken, card, token, review, reported, bind };
}

export async function viaEdge(
  t: TestContext,
  origin: URL,
): Promise<{ edge: Edge; upstream: string }> {
  const edge = await Edge.start(origin);
  edge.forwardOrigin = true;
  t.after(() => edge.stop());
  return { edge, upstream: `https://127.0.0.1:${String(edge.port)}` };
}

export const verdictOf = (prompt: string) => ({
  prompts: [{ uid: "1", tag: "verdict", prompt, selector: "#v" }],
  endSession: false,
});

export async function handOffKey(
  lab: { cardd: Cardd; mate: Session; worker: Session },
  card: Card,
  holdEntry: number,
  reviewKey: string,
): Promise<void> {
  const { cardd, mate, worker } = lab;
  assert.equal(
    await cardd.act(card.id, {
      kind: "answer",
      hold: holdEntry,
      choice: "Continue",
      written: true,
    }),
    200,
  );
  await mate.call("comment", {
    card: card.id,
    text: `The review of ${reviewKey} is resolved, the next round follows`,
    resolves: reviewKey,
  });
  await worker.waitForEntry(
    (entry) => entry.kind === "comment" && entry.fields["resolves"] === reviewKey,
    `the mate's resolution of ${reviewKey}`,
  );
}
