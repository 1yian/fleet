import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Captain, GuardLab, until, type Worker } from "../support/guard-lab.ts";

const SECRET = "hunter2-secret-value";
const READ_PASSWORD = "document.querySelector('#pw').value";
const REFUSED = /captain.*password/i;

let lab: GuardLab;

before(async () => {
  lab = await GuardLab.start(["--site-per-process"], { relay: true });
});
after(async () => {
  await lab.stop();
});

test("a worker that stays connected while the guard loses sight of Chrome is refused until the guard sees again", async () => {
  const relay = lab.relay;
  assert.ok(relay, "the lab has no relay in front of Chrome");
  const worker = await lab.worker();
  const tab = await lab.openPage(worker, "/login", "login");
  const captain = await Captain.at(lab.chrome, tab.target);
  await captain.click("#pw");
  await captain.type(SECRET);
  await until(async () => {
    const reply = await worker.evaluate(tab.session, READ_PASSWORD);
    return reply.ok ? undefined : true;
  }, "the guard to arm");

  relay.blindTheMonitor();
  const blind = await until(async () => {
    const reply = await worker.evaluate(tab.session, READ_PASSWORD);
    return !reply.ok && reply.text.includes("not ready") ? reply : undefined;
  }, "the guard to refuse while it cannot see Chrome");
  assert.ok(!blind.text.includes(SECRET));

  relay.restoreTheMonitor();
  const seen = await until(async () => {
    const reply = await worker.evaluate(tab.session, READ_PASSWORD);
    return !reply.ok && /captain.*password/i.test(reply.text) ? reply : undefined;
  }, "the guard to see the typed password again");
  assert.ok(!seen.text.includes(SECRET));

  await captain.erase(SECRET.length);
  await captain.click("#user");
  const emptied = await until(async () => {
    const reply = await worker.evaluate(tab.session, READ_PASSWORD);
    return reply.ok ? reply : undefined;
  }, "the read to work once the field is empty");
  assert.equal(emptied.text, '""');
  captain.close();
});

async function framePassword(worker: Worker, session: string): Promise<void> {
  await until(async () => {
    const reply = await worker.evaluate(session, "!!document.querySelector('#pw')");
    return reply.ok && reply.text === "true" ? true : undefined;
  }, "the frame's password field to exist");
}

test("after the guard sees Chrome again, a frame that holds a typed password stays refused until its own report has arrived", async () => {
  const relay = lab.relay;
  assert.ok(relay, "the lab has no relay in front of Chrome");
  const worker = await lab.worker();
  const tab = await lab.openPage(worker, "/embed", "embed");
  const frame = await until(async () => {
    const found = (await lab.chrome.targets()).find((target) => target.type === "iframe");
    return found?.id;
  }, "the frame to become its own target");
  const inFrame = await worker.attach(frame);
  await framePassword(worker, inFrame);
  const captain = await Captain.at(lab.chrome, tab.target);
  await captain.clickAt(20, 15);
  await captain.type(SECRET);
  await until(async () => {
    const reply = await worker.evaluate(inFrame, READ_PASSWORD);
    return reply.ok ? undefined : true;
  }, "the guard to arm");

  relay.holdFrames();
  relay.blindTheMonitor();
  await until(async () => {
    const reply = await worker.evaluate(inFrame, READ_PASSWORD);
    return !reply.ok && reply.text.includes("not ready") ? true : undefined;
  }, "the guard to refuse while it cannot see Chrome");

  relay.restoreTheMonitor();
  await until(
    () => (relay.heldFrameMessages() > 0 ? true : undefined),
    "the guard to reach the frame again",
  );
  const waiting = await worker.evaluate(inFrame, READ_PASSWORD);
  assert.equal(waiting.ok, false);
  assert.ok(!waiting.text.includes(SECRET));

  relay.releaseFrames();
  const typed = await until(async () => {
    const reply = await worker.evaluate(inFrame, READ_PASSWORD);
    return !reply.ok && REFUSED.test(reply.text) ? reply : undefined;
  }, "the frame's typed password to be reported");
  assert.ok(!typed.text.includes(SECRET));
  captain.close();
});

test("a tab stays unseen while the guard cannot finish looking at it, and reads work once it has", async () => {
  const relay = lab.relay;
  assert.ok(relay, "the lab has no relay in front of Chrome");
  relay.failTheMonitor("DOM.getDocument");
  const worker = await lab.worker();
  const tab = await worker.open("about:blank");
  const early = await worker.evaluate(tab.session, "document.title");
  assert.equal(early.ok, false);
  assert.match(early.text, /not ready/);

  relay.mendTheMonitor();
  await until(async () => {
    const reply = await worker.evaluate(tab.session, "1 + 1");
    return reply.ok && reply.text === "2" ? true : undefined;
  }, "the read to work once the guard has looked at the tab");
});
