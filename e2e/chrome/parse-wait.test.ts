import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Captain, GuardLab, until } from "../support/guard-lab.ts";

const SECRET = "hunter2-secret-value";
const REFUSED = /captain.*password/i;
const PARSE_WAIT_MS = 800;

let lab: GuardLab;

before(async () => {
  lab = await GuardLab.start([], { parseWaitMs: PARSE_WAIT_MS });
});
after(async () => {
  await lab.stop();
});

async function openHeldPage(): Promise<{
  worker: Awaited<ReturnType<GuardLab["worker"]>>;
  target: string;
  session: string;
}> {
  const worker = await lab.worker();
  const tab = await worker.open("about:blank");
  const navigated = await worker.call(tab.session, "Page.navigate", {
    url: lab.site.url("/held"),
  });
  assert.equal(navigated.ok, true);
  await lab.waitForTab("/held", "held");
  return { worker, ...tab };
}

test("a page that never finishes its parse does not keep workers out for ever", async () => {
  const { worker, target, session } = await openHeldPage();
  await until(async () => {
    const reply = await worker.evaluate(session, "document.title");
    return reply.ok && reply.text === '"held"' ? true : undefined;
  }, "the guard to let a read through once the parse wait is over");
  lab.site.release();
  await lab.chrome.closeTab(target);
});

test("a closed root that the parser adds after the parse wait is over is still guarded while the page loads", async () => {
  const { worker, target, session } = await openHeldPage();
  await until(async () => {
    const reply = await worker.evaluate(session, "document.title");
    return reply.ok ? true : undefined;
  }, "the page to become readable once the parse wait is over");

  lab.site.continueHeld();
  await until(async () => {
    const built = await lab.chrome.evaluate(target, "!!document.querySelector('#x-held')");
    return built === true ? true : undefined;
  }, "the page to build the closed root");
  const captain = await Captain.at(lab.chrome, target);
  await captain.click("#x-held");
  await captain.type(SECRET);

  const refused = await until(async () => {
    const reply = await worker.evaluate(session, "document.title");
    return !reply.ok && REFUSED.test(reply.text) ? reply : undefined;
  }, "the guard to see the password typed while the page is still loading");
  assert.ok(!refused.text.includes(SECRET));
  const snapshot = await worker.call(session, "DOMSnapshot.captureSnapshot", {
    computedStyles: [],
  });
  assert.equal(snapshot.ok, false);
  assert.ok(!snapshot.text.includes(SECRET));
  assert.equal(await lab.chrome.evaluate(target, "document.readyState"), "loading");

  lab.site.release();
  await until(async () => {
    const state = await lab.chrome.evaluate(target, "document.readyState");
    return state === "complete" ? true : undefined;
  }, "the held page to finish");
  const after = await worker.evaluate(session, "document.title");
  assert.equal(after.ok, false);
  assert.match(after.text, REFUSED);

  await captain.erase(SECRET.length);
  await captain.click("#user");
  await until(async () => {
    const reply = await worker.evaluate(session, "document.title");
    return reply.ok && reply.text === '"held"' ? true : undefined;
  }, "the read to work once the page is done and the field is empty");
  captain.close();
  await lab.chrome.closeTab(target);
});
