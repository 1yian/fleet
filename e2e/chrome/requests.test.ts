import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Captain, GuardLab, reads, until, type Worker } from "../support/guard-lab.ts";
import { isRecord, optionalString } from "../support/json.ts";

const SECRET = "hunter2-secret-value";

let lab: GuardLab;

before(async () => {
  lab = await GuardLab.start();
});
after(async () => {
  await lab.stop();
});

test("addresses and the discovery list reach a worker as they are", async () => {
  const worker = await lab.worker();
  const tab = await worker.open("about:blank");
  const url = lab.site.url("/notes?topic=cats");
  assert.equal((await worker.call(tab.session, "Page.navigate", { url })).ok, true);
  await reads(worker, tab.session, "document.title", '"notes"');
  const listed = await (await fetch(`${lab.proxy}/json/list`)).text();
  assert.ok(listed.includes("/notes?topic=cats"));
  const targets = JSON.stringify(await worker.cdp.send("Target.getTargets"));
  assert.ok(targets.includes("/notes?topic=cats"));
});

test("a request that carried a typed password stays hidden after the field is empty, even when a redirect sends it again", async () => {
  const worker = await lab.worker();
  const tab = await lab.openPage(worker, "/spa", "spa");
  assert.equal((await worker.call(tab.session, "Network.enable")).ok, true);
  const before = worker.events.length;
  const captain = await Captain.at(lab.chrome, tab.target);
  await captain.click("#pw");
  await captain.type(SECRET);
  const known = lab.site.received(SECRET);
  await captain.click("#go");
  await until(
    () => (lab.site.heldLogins() > 0 ? true : undefined),
    "the login request to reach the site",
  );
  await reads(worker, tab.session, "document.querySelector('#pw').value", '""');

  lab.site.redirectLogins();
  await until(
    () => (lab.site.received(SECRET) > known ? true : undefined),
    "the redirect to send the password again",
  );
  const requestsSince = (): { method: string; params: unknown }[] =>
    worker.events.slice(before).filter((event) => event.method === "Network.requestWillBeSent");
  await until(
    () => (requestsSince().length >= 2 ? true : undefined),
    "the worker to see the redirected request",
  );
  const requests = requestsSince();
  assert.ok(requests.length >= 2);
  assert.ok(!JSON.stringify(requests).includes(SECRET), "the password is in a request event");
  const params = requests[0]?.params;
  const requestId =
    typeof params === "object" && params !== null && "requestId" in params
      ? String(params.requestId)
      : "";
  const body = await worker.call(tab.session, "Network.getRequestPostData", { requestId });
  assert.equal(body.ok, false);
  assert.ok(!body.text.includes(SECRET));
  captain.close();
});

function sentTo(event: Worker["events"][number], path: string): string | undefined {
  const params = event.params;
  if (event.method !== "Network.requestWillBeSent" || !isRecord(params)) return undefined;
  const request = params["request"];
  const url = isRecord(request) ? optionalString(request, "url") : undefined;
  return url?.endsWith(path) === true ? optionalString(params, "requestId") : undefined;
}

const requestOf = (worker: Worker, path: string): string | undefined =>
  worker.events.map((event) => sentTo(event, path)).find((id) => id !== undefined);

const finished = (worker: Worker, id: string): boolean =>
  worker.events.some(
    (event) =>
      event.method === "Network.loadingFinished" &&
      isRecord(event.params) &&
      event.params["requestId"] === id,
  );

test("the answer to a request that carried a typed password is hidden, and other answers read once nothing is typed", async () => {
  const worker = await lab.worker();
  const tab = await lab.openPage(worker, "/echo", "spa");
  assert.equal((await worker.call(tab.session, "Network.enable")).ok, true);
  const fetched = await worker.evaluate(
    tab.session,
    "fetch('/notes').then((r) => r.text()).then((t) => t.length)",
  );
  assert.equal(fetched.ok, true);
  const notes = await until(() => requestOf(worker, "/notes"), "the notes request");
  await until(() => (finished(worker, notes) ? true : undefined), "the notes answer");
  const plain = await worker.call(tab.session, "Network.getResponseBody", { requestId: notes });
  assert.equal(plain.ok, true);
  assert.ok(plain.text.includes("plain notes"));

  const captain = await Captain.at(lab.chrome, tab.target);
  await captain.click("#pw");
  await captain.type(SECRET);
  const typing = await until(async () => {
    const reply = await worker.call(tab.session, "Network.getResponseBody", { requestId: notes });
    return reply.ok ? undefined : reply;
  }, "the guard to refuse a body read while a password is typed");
  assert.match(typing.text, /captain.*password/i);

  await captain.click("#go");
  const login = await until(() => requestOf(worker, "/api/echo"), "the login request");
  await until(() => (finished(worker, login) ? true : undefined), "the login answer");
  await reads(worker, tab.session, "document.querySelector('#pw').value", '""');
  for (const method of [
    "Network.getResponseBody",
    "Network.searchInResponseBody",
    "Network.streamResourceContent",
  ]) {
    const reply = await worker.call(tab.session, method, { requestId: login, query: "pw=" });
    assert.equal(reply.ok, false, `${method} answered for a request that carried a password`);
    assert.ok(!reply.text.includes(SECRET));
  }
  const again = await worker.call(tab.session, "Network.getResponseBody", { requestId: notes });
  assert.equal(again.ok, true);
  assert.ok(again.text.includes("plain notes"));
  captain.close();
});

function pausedOf(worker: Worker): { requestId: string; networkId: string } | undefined {
  for (const event of worker.events) {
    const params = event.params;
    if (event.method !== "Fetch.requestPaused" || !isRecord(params)) continue;
    const requestId = optionalString(params, "requestId");
    const networkId = optionalString(params, "networkId");
    if (requestId !== undefined && networkId !== undefined) return { requestId, networkId };
  }
  return undefined;
}

test("a response-stage pause of a request that carried a typed password hides the answer under its new id", async () => {
  const worker = await lab.worker();
  const tab = await lab.openPage(worker, "/holdecho", "spa");
  assert.equal((await worker.call(tab.session, "Network.enable")).ok, true);
  const patterns = [{ urlPattern: "*/api/hold", requestStage: "Response" }];
  assert.equal((await worker.call(tab.session, "Fetch.enable", { patterns })).ok, true);
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
  const paused = await until(() => pausedOf(worker), "the response of the login to pause");
  assert.notEqual(paused.requestId, paused.networkId);

  for (const method of ["Fetch.getResponseBody", "Fetch.takeResponseBodyAsStream"]) {
    const reply = await worker.call(tab.session, method, { requestId: paused.requestId });
    assert.equal(reply.ok, false, `${method} answered for a request that carried a password`);
    assert.ok(!reply.text.includes(SECRET));
  }
  const events = JSON.stringify(worker.events.filter((event) => event.method.startsWith("Fetch.")));
  assert.ok(!events.includes(SECRET));
  await worker.call(tab.session, "Fetch.disable");
  captain.close();
});

test("a worker that joins after the field is empty still gets a pending redirect without the body", async () => {
  const first = await lab.worker();
  const tab = await lab.openPage(first, "/spa", "spa");
  const captain = await Captain.at(lab.chrome, tab.target);
  await captain.click("#pw");
  await captain.type(SECRET);
  const known = lab.site.received(SECRET);
  await captain.click("#go");
  await until(
    () => (lab.site.heldLogins() > 0 ? true : undefined),
    "the login request to reach the site",
  );
  await reads(first, tab.session, "document.querySelector('#pw').value", '""');

  const second = await lab.worker();
  const session = await second.attach(tab.target);
  assert.equal((await second.call(session, "Network.enable")).ok, true);
  const before = second.events.length;
  lab.site.redirectLogins();
  await until(
    () => (lab.site.received(SECRET) > known ? true : undefined),
    "the redirect to send the password again",
  );
  const redirected = await until(
    () => second.events.slice(before).find((event) => sentTo(event, "/api/done") !== undefined),
    "the second worker to see the redirected request",
  );
  assert.ok(!JSON.stringify(redirected).includes(SECRET), "the password is in the redirect event");
  const requestId = sentTo(redirected, "/api/done") ?? "";
  const body = await second.call(session, "Network.getRequestPostData", { requestId });
  assert.equal(body.ok, false);
  assert.ok(!body.text.includes(SECRET));
  captain.close();
});

test("a request that carried a typed password cannot be replayed past the guard", async () => {
  const worker = await lab.worker();
  const tab = await lab.openPage(worker, "/xhr", "xhr");
  assert.equal((await worker.call(tab.session, "Network.enable")).ok, true);
  const captain = await Captain.at(lab.chrome, tab.target);
  await captain.click("#pw");
  await captain.type(SECRET);
  const known = lab.site.received(SECRET);
  await captain.click("#go");
  await until(
    () => (lab.site.received(SECRET) > known ? true : undefined),
    "the site to receive the password",
  );
  const once = lab.site.received(SECRET);
  await reads(worker, tab.session, "document.querySelector('#pw').value", '""');
  const requestId = await until(() => requestOf(worker, "/api/done"), "the request to be seen");

  const replay = await worker.call(tab.session, "Network.replayXHR", { requestId });
  assert.equal(replay.ok, false);
  assert.match(replay.text, /not available through the guard/);
  await reads(worker, tab.session, "document.title", '"xhr"');
  assert.equal(lab.site.received(SECRET), once);
  captain.close();
});

test("a form post that the browser sends again later gives a worker no body", async () => {
  const worker = await lab.worker();
  const tab = await lab.openPage(worker, "/login", "login");
  assert.equal((await worker.call(tab.session, "Network.enable")).ok, true);
  const captain = await Captain.at(lab.chrome, tab.target);
  await captain.click("#user");
  await captain.type("captain");
  await captain.click("#pw");
  await captain.type(SECRET);
  const known = lab.site.received(SECRET);
  await captain.press("Enter");
  await until(
    () => (lab.site.received(SECRET) > known ? true : undefined),
    "the site to receive the form",
  );
  await reads(worker, tab.session, "document.title", '"welcome"');

  const sent = lab.site.received(SECRET);
  const before = worker.events.length;
  assert.equal((await worker.call(tab.session, "Page.reload")).ok, true);
  await until(
    () => (lab.site.received(SECRET) > sent ? true : undefined),
    "the browser to send the form again",
  );
  const again = await until(
    () => worker.events.slice(before).find((event) => sentTo(event, "/submit") !== undefined),
    "the worker to see the form sent again",
  );
  assert.ok(!JSON.stringify(again).includes(SECRET), "the password is in the event");
  const requestId = sentTo(again, "/submit") ?? "";
  const body = await worker.call(tab.session, "Network.getRequestPostData", { requestId });
  assert.equal(body.ok, false);
  assert.match(body.text, /captain.*password/i);
  captain.close();
});

test("a worker's own POST with a body reads as usual when nothing was typed", async () => {
  const worker = await lab.worker();
  const tab = await lab.openPage(worker, "/notes", "notes");
  assert.equal((await worker.call(tab.session, "Network.enable")).ok, true);
  const sent = await worker.evaluate(
    tab.session,
    "fetch('/api/done', { method: 'POST', body: 'greeting=hello' }).then((r) => r.text())",
  );
  assert.equal(sent.ok, true);
  const requestId = await until(() => requestOf(worker, "/api/done"), "the post to be seen");
  const body = await worker.call(tab.session, "Network.getRequestPostData", { requestId });
  assert.equal(body.ok, true);
  assert.ok(body.text.includes("greeting=hello"));
});
