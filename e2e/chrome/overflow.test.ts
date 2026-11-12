import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Captain, GuardLab, until } from "../support/guard-lab.ts";
import { isRecord, optionalString } from "../support/json.ts";

const SECRET = "hunter2-secret-value";
const KEPT = 3;
const OTHERS = 8;

let lab: GuardLab;

before(async () => {
  lab = await GuardLab.start([], { relay: true, requestsKept: KEPT });
});
after(async () => {
  await lab.stop();
});

test("when more requests than the store holds started while the guard was blind, none of them is readable once it sees again", async () => {
  const relay = lab.relay;
  assert.ok(relay, "the lab has no relay in front of Chrome");
  const worker = await lab.worker();
  const tab = await lab.openPage(worker, "/spa", "spa");
  assert.equal((await worker.call(tab.session, "Network.enable")).ok, true);
  const before = worker.events.length;
  relay.blindTheMonitor();
  await until(async () => {
    const reply = await worker.evaluate(tab.session, "document.title");
    return !reply.ok && reply.text.includes("not ready") ? true : undefined;
  }, "the guard to say it cannot see Chrome");
  const captain = await Captain.at(lab.chrome, tab.target);
  await captain.click("#pw");
  await captain.type(SECRET);
  await captain.click("#go");
  await until(
    () => (lab.site.heldLogins() > 0 ? true : undefined),
    "the login request to reach the site",
  );
  await lab.chrome.evaluate(
    tab.target,
    `Promise.all(Array.from({ length: ${String(OTHERS)} }, (_, n) => fetch('/notes?n=' + n)))`,
  );
  await until(async () => {
    const field = await lab.chrome.evaluate(tab.target, "document.querySelector('#pw').value");
    return field === "" ? true : undefined;
  }, "the page to empty the field");
  const seen = (): number =>
    worker.events
      .slice(before)
      .filter(
        (event) =>
          event.method === "Network.requestWillBeSent" &&
          isRecord(event.params) &&
          JSON.stringify(event.params).includes("/notes?n="),
      ).length;
  await until(() => (seen() >= OTHERS ? true : undefined), "the worker to see the other requests");

  relay.restoreTheMonitor();
  await until(async () => {
    const reply = await worker.evaluate(tab.session, "document.title");
    return reply.ok ? true : undefined;
  }, "the guard to see Chrome again");
  const login = worker.events
    .slice(before)
    .find(
      (event) =>
        event.method === "Network.requestWillBeSent" &&
        JSON.stringify(event).includes("/api/login"),
    );
  const requestId = isRecord(login?.params)
    ? (optionalString(login.params, "requestId") ?? "")
    : "";
  assert.notEqual(requestId, "", "the worker saw no login request");
  const body = await worker.call(tab.session, "Network.getRequestPostData", { requestId });
  assert.equal(body.ok, false);
  assert.match(body.text, /captain.*password/i);
  const answer = await worker.call(tab.session, "Network.getResponseBody", { requestId });
  assert.equal(answer.ok, false);
  assert.match(answer.text, /captain.*password/i);

  const after = worker.events.length;
  lab.site.redirectLogins();
  const redirected = await until(
    () =>
      worker.events
        .slice(after)
        .find(
          (event) =>
            event.method === "Network.requestWillBeSent" &&
            JSON.stringify(event).includes("/api/done"),
        ),
    "the worker to see the redirect",
  );
  assert.ok(!JSON.stringify(redirected).includes(SECRET), "the password is in the redirect event");
  captain.close();
});
