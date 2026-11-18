import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync, sign as signBytes, type KeyObject } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { Cardd } from "../support/cardd.ts";
import { begin, newCard, status } from "../support/fleet.ts";
import { Lavish } from "../support/lavish.ts";
import { tempDir } from "../support/run-root.ts";

async function fixture(t: TestContext) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const otherSigner = generateKeyPairSync("ed25519").privateKey;
  const cardd = await Cardd.start({
    CARDD_REVIEW_PUBLIC_KEY: publicKey.export({ type: "spki", format: "pem" }).toString(),
  });
  t.after(() => cardd.stop());
  const main = await cardd.connect(cardd.addLane("main"));
  const mate = await cardd.connect(cardd.addLane("cleo", "main"));
  cardd.addProject("web", { maverick: "/clones/web" }, "acme/web");
  const card = await newCard(mate, "Review the plan", "scout");
  const other = await newCard(mate, "Unrelated hold", "scout");
  const worker = await cardd.connect(await begin(mate, card));
  const dir = tempDir("fleet-review-completion-");
  const lavish = await Lavish.start(dir);
  t.after(() => lavish.stop());
  const page = join(dir, "plan.html");
  writeFileSync(page, "<!doctype html><body style='background:#fff'><h1>Plan</h1></body>");
  const opened = execFileSync("lavish-axi", [page, "--no-open"], {
    env: { ...process.env, ...lavish.env },
    encoding: "utf8",
  });
  const session = /https?:\/\/[^\s"']+\/session\/[a-f0-9]+/.exec(opened)?.[0];
  assert.ok(session);
  return { cardd, main, mate, card, other, worker, session, privateKey, otherSigner };
}

async function closeReviewed(
  mate: Awaited<ReturnType<typeof fixture>>["mate"],
  card: Awaited<ReturnType<typeof fixture>>["card"],
) {
  const next = { delivered: { evidence: "Plan reviewed", disposition: "No build remains" } };
  await mate.call("close.begin", { card: card.id, next });
  await mate.call("close.finish", {
    card: card.id,
    next,
    mode: "done",
    text: "Closed",
    archives: [],
    left: [],
  });
  assert.equal(await status(mate, card), "done");
}

async function sendAndEnd(session: string, words: string): Promise<void> {
  const origin = new URL(session).origin;
  const key = new URL(session).pathname.split("/").at(-1) ?? "";
  const sent = await fetch(`${origin}/api/${key}/prompts`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ prompts: [{ tag: "message", prompt: words }], endSession: true }),
  });
  assert.equal(sent.status, 200, await sent.text());
}

function signReceipt(payload: Record<string, unknown>, signer: KeyObject): string {
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const iat = Math.floor(Date.now() / 1000);
  const header = b64({ alg: "EdDSA", typ: "fleet-review-completion+jwt" });
  const body = b64({ aud: "fleet-review-completion", iat, exp: iat + 300, ...payload });
  const input = `${header}.${body}`;
  return `${input}.${signBytes(null, Buffer.from(input), signer).toString("base64url")}`;
}

test("only a trusted terminal receipt settles the current Lavish round and the mate can close", async (t) => {
  const { cardd, main, mate, card, other, worker, session, privateKey, otherSigner } =
    await fixture(t);
  const words = "LGTM you can make this change";
  const ask = (key: string) =>
    worker.call("report", {
      status: "needs-decision",
      key,
      text: `Ready to review: ${session}`,
    });
  const escalate = async (question: string) => {
    await main.call("hold", { card: card.id, question, to: "captain", review: session });
    const round = (await cardd.board()).holds.find((item) => item.card === card.id)?.hold;
    assert.ok(round);
    return round;
  };
  await ask("draft");
  await mate.call("hold", { card: card.id, question: "Please review the draft" });
  const stale = await escalate("Please review the draft");
  await ask("revision");
  const round = await escalate("Please review both rounds");
  await mate.call("hold", { card: other.id, question: "Keep unlanded work?", unlanded: true });
  await main.call("hold", { card: other.id, question: "Keep unlanded work?", to: "captain" });
  const otherHold = (await cardd.board()).holds.find((item) => item.card === other.id)?.hold;
  assert.ok(otherHold);

  const payload = { card: card.id, round, session, action: "send-and-end", words };
  const sign = (claims: Record<string, unknown> = {}, signer = privateKey) =>
    signReceipt({ ...payload, ...claims }, signer);
  const completion = cardd.url
    .replace(/^ws/, "http")
    .replace(/\/session$/, "/api/review-completion");
  const post = async (token?: string) => {
    const response = await fetch(completion, {
      method: "POST",
      headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
    });
    await response.text();
    return response.status;
  };
  assert.equal(await post(), 401);
  assert.equal(await post(sign({}, otherSigner)), 401);
  assert.equal(await post(sign({ action: "send" })), 401);
  assert.equal(await post(sign({ round: stale })), 409);
  assert.equal(await post(sign({ card: other.id })), 409);
  assert.equal(await post(sign({ card: other.id, round: otherHold })), 409);
  assert.equal(await post(sign({ session: `${session}00` })), 409);
  await worker.call("report", { status: "resolved", key: "draft", text: words });
  await worker.call("report", { status: "resolved", key: "revision", text: words });
  await assert.rejects(mate.call("release", { card: card.id, words }), /not in the captain's/);
  assert.equal(await status(mate, card), "needs-you");

  await sendAndEnd(session, words);
  assert.equal(await status(mate, card), "needs-you");

  const receipt = sign();
  assert.equal(await post(receipt), 200);
  assert.equal(await post(receipt), 200);
  assert.equal(await status(mate, card), "working");
  assert.equal(await status(mate, other), "needs-you");
  const record = await mate.waitForEntry(
    (entry) => entry.kind === "review-feedback",
    "verified review answer",
  );
  assert.equal(record.author, "captain");
  assert.equal(record.body, words);
  assert.deepEqual(record.fields["keys"], ["draft", "revision"]);
  await assert.rejects(mate.call("release", { card: other.id, words }), /not in the captain's/);

  await ask("new-round");
  await mate.call("hold", { card: card.id, question: "New review" });
  await escalate("New review");
  assert.equal(await post(receipt), 200);
  assert.equal(await status(mate, card), "needs-you");
  const open = (await cardd.board()).holds.find((item) => item.card === card.id);
  assert.ok(open);
  assert.equal(await post(sign({ round: open.hold })), 200);
  assert.equal(
    await cardd.act(other.id, {
      kind: "answer",
      hold: otherHold,
      choice: "Board fallback",
      written: true,
    }),
    200,
  );
  await worker.call("report", { status: "done", text: "Plan delivered" });
  await closeReviewed(mate, card);
});
