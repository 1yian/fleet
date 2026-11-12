import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { bodyOf, eventOf, requestIdOf } from "../support/events.ts";
import { Captain, GuardLab, reads, until } from "../support/guard-lab.ts";
import { isRecord, optionalString } from "../support/json.ts";

const SECRET = "hunter2-secret-value";

let lab: GuardLab;

before(async () => {
  lab = await GuardLab.start();
});
after(async () => {
  await lab.stop();
});

async function type(captain: Captain, user: boolean): Promise<void> {
  if (user) {
    await captain.click("#user");
    await captain.type("captain");
  }
  await captain.click("#pw");
  await captain.type(SECRET);
}

test("a form post that the browser sends again reaches a worker that intercepts it without a body", async () => {
  const worker = await lab.worker();
  const tab = await lab.openPage(worker, "/login", "login");
  const captain = await Captain.at(lab.chrome, tab.target);
  await type(captain, true);
  const known = lab.site.received(SECRET);
  await captain.press("Enter");
  await until(
    () => (lab.site.received(SECRET) > known ? true : undefined),
    "the site to receive the form",
  );
  await reads(worker, tab.session, "document.title", '"welcome"');
  const patterns = [{ urlPattern: "*/submit" }];
  assert.equal((await worker.call(tab.session, "Fetch.enable", { patterns })).ok, true);

  const before = worker.events.length;
  assert.equal((await worker.call(tab.session, "Page.reload")).ok, true);
  const paused = await until(
    () => eventOf(worker.events, "Fetch.requestPaused", before, "/submit"),
    "the repost to pause",
  );
  assert.ok(!JSON.stringify(paused).includes(SECRET), "the password is in the paused event");
  assert.deepEqual(bodyOf(paused), [undefined, undefined]);
  await worker.call(tab.session, "Fetch.disable");
  captain.close();
});

test("an authentication challenge for a form post that the captain typed reaches a worker without the body", async () => {
  const worker = await lab.worker();
  const tab = await lab.openPage(worker, "/authlogin", "authlogin");
  const patterns = [{ urlPattern: "*/secure" }];
  const enabled = { handleAuthRequests: true, patterns };
  assert.equal((await worker.call(tab.session, "Fetch.enable", enabled)).ok, true);
  const captain = await Captain.at(lab.chrome, tab.target);
  await type(captain, true);
  const before = worker.events.length;
  await captain.press("Enter");
  const paused = await until(
    () => eventOf(worker.events, "Fetch.requestPaused", before, "/secure"),
    "the form post to pause",
  );
  assert.ok(!JSON.stringify(paused).includes(SECRET), "the password is in the paused event");
  const requestId = requestIdOf(paused);
  assert.equal((await worker.call(tab.session, "Fetch.continueRequest", { requestId })).ok, true);
  const challenge = await until(
    () => eventOf(worker.events, "Fetch.authRequired", before, "/secure"),
    "the server's challenge",
  );
  assert.ok(!JSON.stringify(challenge).includes(SECRET), "the password is in the challenge");
  assert.deepEqual(bodyOf(challenge), [undefined, undefined]);
  const cancel = { requestId, authChallengeResponse: { response: "CancelAuth" } };
  await worker.call(tab.session, "Fetch.continueWithAuth", cancel);
  await worker.call(tab.session, "Fetch.disable");
  captain.close();
});

test("an authentication challenge that comes after the field is empty still reaches a worker without the body", async () => {
  const worker = await lab.worker();
  const tab = await lab.openPage(worker, "/authspa", "spa");
  const patterns = [{ urlPattern: "*/api/auth" }];
  const enabled = { handleAuthRequests: true, patterns };
  assert.equal((await worker.call(tab.session, "Fetch.enable", enabled)).ok, true);
  const captain = await Captain.at(lab.chrome, tab.target);
  await type(captain, false);
  const before = worker.events.length;
  await captain.click("#go");
  const paused = await until(
    () => eventOf(worker.events, "Fetch.requestPaused", before, "/api/auth"),
    "the post to pause",
  );
  const requestId = requestIdOf(paused);
  assert.equal((await worker.call(tab.session, "Fetch.continueRequest", { requestId })).ok, true);
  await until(
    () => (lab.site.heldChallenges() > 0 ? true : undefined),
    "the post to reach the site",
  );
  await reads(worker, tab.session, "document.querySelector('#pw').value", '""');

  lab.site.challengeAll();
  const challenge = await until(
    () => eventOf(worker.events, "Fetch.authRequired", before, "/api/auth"),
    "the server's challenge",
  );
  assert.ok(!JSON.stringify(challenge).includes(SECRET), "the password is in the challenge");
  assert.deepEqual(bodyOf(challenge), [undefined, undefined]);
  const cancel = { requestId, authChallengeResponse: { response: "CancelAuth" } };
  await worker.call(tab.session, "Fetch.continueWithAuth", cancel);
  await worker.call(tab.session, "Fetch.disable");
  captain.close();
});

test("Network interception hides the body of a form that the captain typed", async (t) => {
  const worker = await lab.worker();
  const tab = await lab.openPage(worker, "/login", "login");
  const patterns = [{ urlPattern: "*/submit" }];
  const enabled = await worker.call(tab.session, "Network.setRequestInterception", { patterns });
  if (!enabled.ok) {
    t.skip("this Chrome has no Network.setRequestInterception, so no Network.requestIntercepted");
    return;
  }
  const captain = await Captain.at(lab.chrome, tab.target);
  await type(captain, true);
  const before = worker.events.length;
  await captain.press("Enter");
  const intercepted = await until(
    () => eventOf(worker.events, "Network.requestIntercepted", before, "/submit"),
    "the form post to be intercepted",
  );
  assert.ok(!JSON.stringify(intercepted).includes(SECRET), "the password is in the event");
  const interceptionId = isRecord(intercepted.params)
    ? (optionalString(intercepted.params, "interceptionId") ?? "")
    : "";
  await worker.call(tab.session, "Network.continueInterceptedRequest", { interceptionId });
  captain.close();
});
