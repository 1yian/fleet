import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Captain, GuardLab, reads, until, type Worker } from "../support/guard-lab.ts";
import { isRecord, optionalString } from "../support/json.ts";

const SECRET = "hunter2-secret-value";
const READ_PASSWORD = "document.querySelector('#pw').value";
const REFUSED = /captain.*password/i;

let lab: GuardLab;

before(async () => {
  lab = await GuardLab.start(["--site-per-process"], { relay: true, parseWaitMs: 60_000 });
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
  await captain.clickIntoFrame(frame, "#pw", 20, 15);
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

test("a tab that navigates stays unseen while the guard cannot finish its look after the parse", async () => {
  const relay = lab.relay;
  assert.ok(relay, "the lab has no relay in front of Chrome");
  const worker = await lab.worker();
  const tab = await lab.openPage(worker, "/login", "login");
  const before = relay.refusedCalls();
  relay.failTheMonitor("DOM.getDocument");
  const navigated = await worker.call(tab.session, "Page.navigate", {
    url: lab.site.url("/notes"),
  });
  assert.equal(navigated.ok, true);
  await until(
    () => (relay.refusedCalls() >= before + 2 ? true : undefined),
    "the guard to fail its look after the parse and to try again",
  );
  const blocked = await worker.evaluate(tab.session, "document.title");
  assert.equal(blocked.ok, false);
  assert.match(blocked.text, /not ready/);

  relay.mendTheMonitor();
  await until(async () => {
    const reply = await worker.evaluate(tab.session, "document.title");
    return reply.ok && reply.text === '"notes"' ? true : undefined;
  }, "the read to work once the guard has looked at the new page");
});

async function startHeldPage(
  relay: NonNullable<typeof lab.relay>,
  worker: Worker,
): Promise<{ target: string; session: string }> {
  const tab = await worker.open("about:blank");
  const scans = relay.callsOf("DOM.getDocument");
  const navigated = await worker.call(tab.session, "Page.navigate", {
    url: lab.site.url("/held"),
  });
  assert.equal(navigated.ok, true);
  await lab.waitForTab("/held", "held");
  await until(
    () => (relay.callsOf("DOM.getDocument") > scans ? true : undefined),
    "the guard to look at the page before its parse is done",
  );
  return tab;
}

test("a closed root that the parse builds after the guard's look is guarded while the page is still loading", async () => {
  const relay = lab.relay;
  assert.ok(relay, "the lab has no relay in front of Chrome");
  const worker = await lab.worker();
  const tab = await startHeldPage(relay, worker);
  lab.site.continueHeld();
  await until(async () => {
    const built = await lab.chrome.evaluate(tab.target, "!!document.querySelector('#x-held')");
    return built === true ? true : undefined;
  }, "the page to build the closed root");
  const captain = await Captain.at(lab.chrome, tab.target);
  await captain.click("#x-held");
  await captain.type(SECRET);

  const early = await worker.evaluate(tab.session, "document.title");
  assert.equal(early.ok, false);
  assert.match(early.text, /not ready|captain.*password/i);
  assert.ok(!early.text.includes(SECRET));
  const snapshot = await worker.call(tab.session, "DOMSnapshot.captureSnapshot", {
    computedStyles: [],
  });
  assert.equal(snapshot.ok, false);
  assert.ok(!snapshot.text.includes(SECRET));
  lab.site.release();
  const looked = await until(async () => {
    const reply = await worker.evaluate(tab.session, "document.title");
    return !reply.ok && REFUSED.test(reply.text) ? reply : undefined;
  }, "the guard to see the password typed into the page once its parse is done");
  assert.ok(!looked.text.includes(SECRET));

  await captain.erase(SECRET.length);
  await captain.click("#user");
  await until(async () => {
    const reply = await worker.evaluate(tab.session, "document.title");
    return reply.ok && reply.text === '"held"' ? true : undefined;
  }, "the read to work once the page is done and the field is empty");
  captain.close();
  await lab.chrome.closeTab(tab.target);
});

test("the guard lets go of what it resolves while it scans a page that is still loading", async () => {
  const relay = lab.relay;
  assert.ok(relay, "the lab has no relay in front of Chrome");
  const worker = await lab.worker();
  const tab = await startHeldPage(relay, worker);
  lab.site.continueHeld();
  await until(async () => {
    const built = await lab.chrome.evaluate(tab.target, "!!document.querySelector('#x-held')");
    return built === true ? true : undefined;
  }, "the page to build the closed root");
  const scans = relay.callsOf("DOM.getDocument");
  await until(
    () => (relay.callsOf("DOM.getDocument") >= scans + 3 ? true : undefined),
    "the guard to scan the page three more times",
  );
  await until(
    () => (relay.heldObjects() === 0 ? true : undefined),
    "the guard to let go of the objects it resolved",
  );
  lab.site.release();
  await lab.chrome.closeTab(tab.target);
});

test("the guard lets go of what it resolves while a page replaces its closed roots", async () => {
  const relay = lab.relay;
  assert.ok(relay, "the lab has no relay in front of Chrome");
  const worker = await lab.worker();
  const tab = await lab.openPage(worker, "/built", "built");
  const scans = relay.callsOf("DOM.getDocument");
  for (let round = 1; round <= 3; round++) {
    assert.equal((await worker.evaluate(tab.session, "build()")).ok, true);
    await until(
      () => (relay.callsOf("DOM.getDocument") >= scans + round ? true : undefined),
      `the guard to scan after replacement ${String(round)}`,
    );
  }
  await until(
    () => (relay.heldObjects() === 0 ? true : undefined),
    "the guard to let go of the objects it resolved",
  );
  await lab.chrome.closeTab(tab.target);
});

test("a request that started while a password was typed stays hidden from a worker whose events arrive after the field is empty", async () => {
  const relay = lab.relay;
  assert.ok(relay, "the lab has no relay in front of Chrome");
  const worker = await lab.worker();
  const tab = await lab.openPage(worker, "/spa", "spa");
  assert.equal((await worker.call(tab.session, "Network.enable")).ok, true);
  relay.holdWorkerEvents();
  const before = worker.events.length;
  const captain = await Captain.at(lab.chrome, tab.target);
  await captain.click("#pw");
  await captain.type(SECRET);
  await captain.click("#go");
  await until(
    () => (lab.site.heldLogins() > 0 ? true : undefined),
    "the login request to reach the site",
  );
  await until(async () => {
    const reply = await worker.evaluate(tab.session, "document.title");
    return reply.ok ? true : undefined;
  }, "the guard to see the field empty");
  const early = worker.events
    .slice(before)
    .filter((event) => event.method === "Network.requestWillBeSent");
  assert.equal(early.length, 0, "the worker has seen the request already");

  relay.releaseWorkerEvents();
  const sent = await until(
    () =>
      worker.events
        .slice(before)
        .find(
          (event) =>
            event.method === "Network.requestWillBeSent" &&
            JSON.stringify(event).includes("/api/login"),
        ),
    "the worker to see the login request",
  );
  assert.ok(!JSON.stringify(sent).includes(SECRET), "the password is in the request event");
  const params = sent.params;
  const requestId =
    typeof params === "object" && params !== null && "requestId" in params
      ? String(params.requestId)
      : "";
  const body = await worker.call(tab.session, "Network.getRequestPostData", { requestId });
  assert.equal(body.ok, false);
  assert.ok(!body.text.includes(SECRET));
  lab.site.redirectLogins();
  captain.close();
});

test("a request that started while the guard could not see Chrome stays hidden once it can", async () => {
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
  await until(async () => {
    const field = await lab.chrome.evaluate(tab.target, "document.querySelector('#pw').value");
    return field === "" ? true : undefined;
  }, "the page to empty the field");

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
  const params = login?.params;
  const requestId =
    typeof params === "object" && params !== null && "requestId" in params
      ? String(params.requestId)
      : "";
  assert.notEqual(requestId, "", "the worker saw no login request");
  const body = await worker.call(tab.session, "Network.getRequestPostData", { requestId });
  assert.equal(body.ok, false);
  assert.ok(!body.text.includes(SECRET));
  const answer = await worker.call(tab.session, "Network.getResponseBody", { requestId });
  assert.equal(answer.ok, false);
  assert.match(answer.text, /captain.*password/i);

  const seen = worker.events.length;
  lab.site.redirectLogins();
  const redirected = await until(
    () =>
      worker.events
        .slice(seen)
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

test("a request that starts while a frame is not yet prepared stays hidden once it is", async () => {
  const relay = lab.relay;
  assert.ok(relay, "the lab has no relay in front of Chrome");
  const worker = await lab.worker();
  const tab = await lab.openPage(worker, "/embedspa", "embedspa");
  const frame = await until(async () => {
    const found = (await lab.chrome.targets()).find((target) => target.type === "iframe");
    return found?.id;
  }, "the frame to become its own target");
  const inFrame = await worker.attach(frame);
  assert.equal((await worker.call(inFrame, "Network.enable")).ok, true);
  const before = worker.events.length;

  relay.holdFrames();
  relay.blindTheMonitor();
  await until(async () => {
    const reply = await worker.evaluate(tab.session, "document.title");
    return !reply.ok && reply.text.includes("not ready") ? true : undefined;
  }, "the guard to say it cannot see Chrome");
  relay.restoreTheMonitor();
  await until(
    () => (relay.heldFrameMessages() > 0 ? true : undefined),
    "the guard to start on the frame again",
  );
  const captain = await Captain.at(lab.chrome, tab.target);
  await captain.clickAt(20, 45);
  await captain.type(SECRET);
  await captain.clickAt(20, 75);
  await until(
    () => (lab.site.heldLogins() > 0 ? true : undefined),
    "the login request to reach the site",
  );
  await until(async () => {
    const field = await lab.chrome.evaluate(frame, "document.querySelector('#pw').value");
    return field === "" ? true : undefined;
  }, "the page to empty the field");

  relay.releaseFrames();
  await reads(worker, inFrame, "document.querySelector('#pw').value", '""');
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
  const body = await worker.call(inFrame, "Network.getRequestPostData", { requestId });
  assert.equal(body.ok, false);
  assert.match(body.text, /captain.*password/i);

  const seen = worker.events.length;
  lab.site.redirectLogins();
  const redirected = await until(
    () =>
      worker.events
        .slice(seen)
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

test("a worker that gives up before Chrome has answered leaves no connection to Chrome open", async () => {
  const relay = lab.relay;
  assert.ok(relay, "the lab has no relay in front of Chrome");
  relay.holdHandshakes();
  try {
    const socket = new WebSocket(`${lab.guard.replace("http", "ws")}/devtools/browser/abandoned`);
    socket.addEventListener("error", () => undefined);
    await until(
      () => (relay.openHandshakes() === 1 ? true : undefined),
      "the guard to ask Chrome for a connection",
    );
    socket.close();
    await until(
      () => (relay.openHandshakes() === 0 ? true : undefined),
      "the guard to let go of its connection to Chrome",
    );
  } finally {
    relay.releaseHandshakes();
  }
});
