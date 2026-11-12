import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Captain, GuardLab, reads, until } from "../support/guard-lab.ts";

const SECRET = "hunter2-secret-value";

let lab: GuardLab;

before(async () => {
  lab = await GuardLab.start();
});
after(async () => {
  await lab.stop();
});

test("a password that the captain submits in a GET form is not in the worker's view of the address", async () => {
  const worker = await lab.worker();
  const tab = await lab.openPage(worker, "/getlogin", "getlogin");
  assert.equal((await worker.call(tab.session, "Network.enable")).ok, true);
  assert.equal((await worker.call(tab.session, "Page.enable")).ok, true);
  const before = worker.events.length;
  const captain = await Captain.at(lab.chrome, tab.target);
  await captain.click("#user");
  await captain.type("captain");
  await captain.click("#pw");
  await captain.type(SECRET);
  await captain.press("Enter");
  await reads(worker, tab.session, "document.title", '"notes"');

  const direct = await lab.chrome.targets();
  assert.ok(
    direct.some((target) => target.url.includes(SECRET)),
    "Chrome's own list does not show the password, so nothing was submitted",
  );
  const events = JSON.stringify(worker.events.slice(before));
  assert.ok(events.includes("/welcome"), "the worker saw no navigation");
  assert.ok(!events.includes(SECRET), "the password is in the worker's events");
  const targets = JSON.stringify(await worker.cdp.send("Target.getTargets"));
  assert.ok(targets.includes("/welcome"));
  assert.ok(!targets.includes(SECRET), "the password is in Target.getTargets");
  const listed = await (await fetch(`${lab.proxy}/json/list`)).text();
  assert.ok(listed.includes("/welcome"));
  assert.ok(!listed.includes(SECRET), "the password is in the discovery list");
  const history = await worker.call(tab.session, "Page.getNavigationHistory");
  assert.equal(history.ok, true);
  assert.ok(!history.text.includes(SECRET), "the password is in the navigation history");
  captain.close();
});

test("an address without a password stays as it is", async () => {
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
  await captain.click("#go");
  await until(
    () => (lab.site.heldLogins() > 0 ? true : undefined),
    "the login request to reach the site",
  );
  await reads(worker, tab.session, "document.querySelector('#pw').value", '""');

  lab.site.redirectLogins();
  await until(
    () => (lab.site.submitted.some((body) => body.includes(SECRET)) ? true : undefined),
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
