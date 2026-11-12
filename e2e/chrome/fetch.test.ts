import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { bodyOf, eventOf, requestIdOf } from "../support/events.ts";
import { Captain, GuardLab, reads, until } from "../support/guard-lab.ts";

const SECRET = "hunter2-secret-value";

let lab: GuardLab;

before(async () => {
  lab = await GuardLab.start([], { relay: true });
  lab.relay?.omitNetworkIds();
});
after(async () => {
  await lab.stop();
});

test("a response that Fetch pauses without a Network id stays hidden after the field is empty", async () => {
  const worker = await lab.worker();
  const tab = await lab.openPage(worker, "/holdecho", "spa");
  const patterns = [{ urlPattern: "*/api/hold", requestStage: "Response" }];
  assert.equal((await worker.call(tab.session, "Fetch.enable", { patterns })).ok, true);
  const before = worker.events.length;
  const captain = await Captain.at(lab.chrome, tab.target);
  await captain.click("#pw");
  await captain.type(SECRET);
  await captain.click("#go");
  await until(
    () => (lab.site.heldEchoes() > 0 ? true : undefined),
    "the login request to reach the site",
  );
  await reads(worker, tab.session, "document.querySelector('#pw').value", '""');

  lab.site.answerEchoes();
  const paused = await until(
    () => eventOf(worker.events, "Fetch.requestPaused", before, "/api/hold"),
    "the response to pause",
  );
  assert.ok(!JSON.stringify(paused).includes(SECRET), "the password is in the paused event");
  assert.deepEqual(bodyOf(paused), [undefined, undefined]);
  const requestId = requestIdOf(paused);
  for (const method of ["Fetch.getResponseBody", "Fetch.takeResponseBodyAsStream"]) {
    const reply = await worker.call(tab.session, method, { requestId });
    assert.equal(reply.ok, false, `${method} answered for a request that carried a password`);
    assert.match(reply.text, /captain.*password/i);
  }
  await worker.call(tab.session, "Fetch.disable");
  captain.close();
});

test("a redirect that Fetch pauses without a Network id carries no body once the field is empty", async () => {
  const worker = await lab.worker();
  const tab = await lab.openPage(worker, "/spa", "spa");
  const patterns = [{ urlPattern: "*/api/*", requestStage: "Request" }];
  assert.equal((await worker.call(tab.session, "Fetch.enable", { patterns })).ok, true);
  const before = worker.events.length;
  const captain = await Captain.at(lab.chrome, tab.target);
  await captain.click("#pw");
  await captain.type(SECRET);
  await captain.click("#go");
  const first = await until(
    () => eventOf(worker.events, "Fetch.requestPaused", before, "/api/login"),
    "the login request to pause",
  );
  await reads(worker, tab.session, "document.querySelector('#pw').value", '""');
  const sent = await worker.call(tab.session, "Fetch.continueRequest", {
    requestId: requestIdOf(first),
  });
  assert.equal(sent.ok, true);
  await until(
    () => (lab.site.heldLogins() > 0 ? true : undefined),
    "the login request to reach the site",
  );

  lab.site.redirectLogins();
  const again = await until(
    () => eventOf(worker.events, "Fetch.requestPaused", before, "/api/done"),
    "the redirect to pause",
  );
  assert.ok(!JSON.stringify(again).includes(SECRET), "the password is in the redirect");
  assert.deepEqual(bodyOf(again), [undefined, undefined]);
  await worker.call(tab.session, "Fetch.disable");
  captain.close();
});
