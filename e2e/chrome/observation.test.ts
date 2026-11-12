import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { eventOf, requestIdOf } from "../support/events.ts";
import { Captain, GuardLab, until } from "../support/guard-lab.ts";

const SECRET = "hunter2-secret-value";

let lab: GuardLab;

before(async () => {
  lab = await GuardLab.start([], { relay: true });
});
after(async () => {
  await lab.stop();
});

test("a request that starts before the guard's first look at a page has worked stays hidden once it has", async () => {
  const relay = lab.relay;
  assert.ok(relay, "the lab has no relay in front of Chrome");
  await lab.stopGuard();
  const opened = await lab.chrome.open(lab.site.url("/closedspa"));
  const target = await lab.waitForTab(opened, "closedspa");
  const failed = relay.refusedCalls();
  relay.failTheMonitor("DOM.getDocument");
  await lab.restartGuard();
  const worker = await lab.worker();
  const session = await worker.attach(target);
  assert.equal((await worker.call(session, "Network.enable")).ok, true);
  await until(
    () => (relay.refusedCalls() > failed ? true : undefined),
    "the guard's first look to fail",
  );

  const captain = await Captain.at(lab.chrome, target);
  await captain.clickAt(20, 15);
  await captain.type(SECRET);
  const before = worker.events.length;
  await captain.clickAt(20, 45);
  await until(
    () => (lab.site.heldLogins() > 0 ? true : undefined),
    "the login request to reach the site",
  );
  await until(async () => {
    const field = await lab.chrome.evaluate(target, "window.fieldValue()");
    return field === "" ? true : undefined;
  }, "the page to empty the field");

  relay.mendTheMonitor();
  await until(async () => {
    const reply = await worker.evaluate(session, "document.title");
    return reply.ok ? true : undefined;
  }, "the guard's first look to work");
  const login = await until(
    () => eventOf(worker.events, "Network.requestWillBeSent", before, "/api/login"),
    "the worker to see the login request",
  );
  const requestId = requestIdOf(login);
  const body = await worker.call(session, "Network.getRequestPostData", { requestId });
  assert.equal(body.ok, false);
  assert.match(body.text, /captain.*password/i);
  const answer = await worker.call(session, "Network.getResponseBody", { requestId });
  assert.equal(answer.ok, false);
  assert.match(answer.text, /captain.*password/i);

  const seen = worker.events.length;
  lab.site.redirectLogins();
  const redirected = await until(
    () => eventOf(worker.events, "Network.requestWillBeSent", seen, "/api/done"),
    "the worker to see the redirect",
  );
  assert.ok(!JSON.stringify(redirected).includes(SECRET), "the password is in the redirect event");
  captain.close();
});
