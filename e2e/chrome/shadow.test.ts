import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Captain, GuardLab, until } from "../support/guard-lab.ts";

const SECRET = "hunter2-secret-value";
const SEEDED = "seeded-secret";
const REFUSED = /captain.*password/i;

let lab: GuardLab;

before(async () => {
  lab = await GuardLab.start();
});
after(async () => {
  await lab.stop();
});

test("a password typed into a closed shadow root is guarded, and readable again once the field is empty", async () => {
  const worker = await lab.worker();
  const tab = await lab.openPage(worker, "/closed", "closed");
  assert.equal((await worker.evaluate(tab.session, "fieldValue()")).text, '""');
  const captain = await Captain.at(lab.chrome, tab.target);

  await captain.click("#login");
  await captain.type(SECRET);
  const refused = await until(async () => {
    const reply = await worker.evaluate(tab.session, "fieldValue()");
    return reply.ok ? undefined : reply;
  }, "the guard to refuse a read of the closed field");
  assert.match(refused.text, REFUSED);
  assert.ok(!refused.text.includes(SECRET));

  await captain.erase(SECRET.length);
  await captain.click("#user");
  const emptied = await until(async () => {
    const reply = await worker.evaluate(tab.session, "fieldValue()");
    return reply.ok ? reply : undefined;
  }, "the read to work once the closed field is empty");
  assert.equal(emptied.text, '""');
  captain.close();
  await lab.chrome.closeTab(tab.target);
});

test("a password in a closed shadow root before the guard starts is guarded", async () => {
  await lab.stopGuard();
  await lab.chrome.open(lab.site.url("/closed"));
  const target = await lab.waitForTab("/closed", "closed");
  const captain = await Captain.at(lab.chrome, target);
  await captain.click("#login");
  await captain.type(SECRET);

  await lab.restartGuard();
  const worker = await lab.worker();
  const session = await worker.attach(target);
  const reply = await worker.evaluate(session, "fieldValue()");
  assert.equal(reply.ok, false);
  assert.match(reply.text, REFUSED);
  assert.ok(!reply.text.includes(SECRET));

  await captain.erase(SECRET.length);
  await captain.click("#user");
  await until(async () => {
    const again = await worker.evaluate(session, "fieldValue()");
    return again.ok && again.text === '""' ? true : undefined;
  }, "the read to work once the closed field is empty");
  captain.close();
  await lab.chrome.closeTab(target);
});

test("a populated password in an open shadow root before the guard starts is guarded", async () => {
  await lab.stopGuard();
  await lab.chrome.open(lab.site.url("/filled"));
  const target = await lab.waitForTab("/filled", "filled");

  await lab.restartGuard();
  const worker = await lab.worker();
  const session = await worker.attach(target);
  const reply = await worker.evaluate(
    session,
    "document.querySelector('x-filled').shadowRoot.querySelector('input').value",
  );
  assert.equal(reply.ok, false);
  assert.match(reply.text, REFUSED);
  assert.ok(!reply.text.includes(SEEDED));
  await lab.chrome.closeTab(target);
});

test("a populated password in an open shadow root that a page builds after the guard is there is guarded", async () => {
  const worker = await lab.worker();
  const tab = await worker.open("about:blank");
  const navigated = await worker.call(tab.session, "Page.navigate", {
    url: lab.site.url("/filled"),
  });
  assert.equal(navigated.ok, true);

  const reply = await until(async () => {
    const read = await worker.evaluate(tab.session, "document.title");
    return !read.ok ? read : undefined;
  }, "the guard to refuse the page with a populated password");
  assert.match(reply.text, REFUSED);
  await lab.chrome.closeTab(tab.target);
});

test("a populated password in an open shadow root that the page's markup declares is guarded", async () => {
  const worker = await lab.worker();
  const tab = await worker.open("about:blank");
  const navigated = await worker.call(tab.session, "Page.navigate", {
    url: lab.site.url("/declared"),
  });
  assert.equal(navigated.ok, true);

  const reply = await until(async () => {
    const read = await worker.evaluate(tab.session, "document.title");
    return !read.ok ? read : undefined;
  }, "the guard to refuse the page with a declared populated password");
  assert.match(reply.text, REFUSED);
  await lab.chrome.closeTab(tab.target);
});
