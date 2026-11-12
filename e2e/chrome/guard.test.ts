import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { after, before, test } from "node:test";
import { chromium } from "playwright";
import { isRecord, optionalString } from "../support/json.ts";
import { Captain, GuardLab, reads, until, type Worker } from "../support/guard-lab.ts";

const SECRET = "hunter2-secret-value";
const READ_PASSWORD = "document.querySelector('#pw').value";
const REFUSED = /captain.*password/i;

let lab: GuardLab;

before(async () => {
  lab = await GuardLab.start(["--site-per-process"]);
});
after(async () => {
  await lab.stop();
});

const login = (worker: Worker): Promise<{ target: string; session: string }> =>
  lab.openPage(worker, "/login", "login");

const READS = [
  ["Runtime.evaluate", { expression: READ_PASSWORD, returnByValue: true }],
  ["Runtime.callFunctionOn", { functionDeclaration: "() => 1", objectId: "x" }],
  ["Runtime.getProperties", { objectId: "x" }],
  ["DOM.getDocument", { depth: -1, pierce: true }],
  ["DOM.getOuterHTML", { nodeId: 1 }],
  ["DOMSnapshot.captureSnapshot", { computedStyles: [] }],
  ["Accessibility.getFullAXTree", {}],
  ["Page.captureScreenshot", { format: "png" }],
  ["Page.printToPDF", {}],
  ["Page.captureSnapshot", {}],
] as const;

async function refusedEverywhere(worker: Worker, session: string): Promise<void> {
  for (const [method, params] of READS) {
    const reply = await worker.call(session, method, params);
    assert.equal(reply.ok, false, `${method} was answered while a password sat in the field`);
    assert.match(reply.text, REFUSED, `${method} said: ${reply.text}`);
    assert.ok(!reply.text.includes(SECRET), `${method} echoed the password`);
  }
}

test("a worker reads and drives a tab through the guard as it would without it", async () => {
  const worker = await lab.worker();
  const tab = await login(worker);

  assert.equal((await worker.evaluate(tab.session, READ_PASSWORD)).text, '""');
  assert.equal((await worker.call(tab.session, "DOM.getDocument", { depth: 1 })).ok, true);
  const shot = await worker.call(tab.session, "Page.captureScreenshot", { format: "png" });
  assert.equal(shot.ok, true);
  assert.ok(shot.text.length > 100, "the screenshot was empty");

  const tunnel = await worker.call(tab.session, "Target.sendMessageToTarget", {
    sessionId: tab.session,
    message: "{}",
  });
  assert.equal(tunnel.ok, false);
  assert.match(tunnel.text, /not available through the guard/);
});

test("while the captain types a password, the worker cannot read that tab, and can again once the field is empty", async () => {
  const worker = await lab.worker();
  const tab = await login(worker);
  const other = await worker.open(lab.site.url("/notes"));
  const captain = await Captain.at(lab.chrome, tab.target);

  await captain.click("#pw");
  await captain.type(SECRET);

  await until(async () => {
    const reply = await worker.evaluate(tab.session, READ_PASSWORD);
    return reply.ok ? undefined : true;
  }, "the guard to refuse the read");
  await refusedEverywhere(worker, tab.session);

  await reads(worker, other.session, "document.title", '"notes"');
  assert.equal((await worker.call(tab.session, "Page.bringToFront")).ok, true);

  await captain.erase(SECRET.length);
  await captain.click("#user");
  const emptied = await until(async () => {
    const reply = await worker.evaluate(tab.session, READ_PASSWORD);
    return reply.ok ? reply : undefined;
  }, "the read to work once the field is empty");
  assert.equal(emptied.text, '""');
  captain.close();
});

test("a page that puts the cursor in its own password field is not refused until someone uses the field", async () => {
  const worker = await lab.worker();
  const tab = await worker.open(lab.site.url("/autofocus"));
  await reads(
    worker,
    tab.session,
    "document.title + ':' + document.activeElement.id",
    '"autofocus:pw"',
  );

  const captain = await Captain.at(lab.chrome, tab.target);
  await captain.click("#pw");
  await until(async () => {
    const reply = await worker.evaluate(tab.session, "document.title");
    return reply.ok ? undefined : reply;
  }, "the guard to refuse once the captain used the field");
  captain.close();
});

test("a focused password field refuses reads before the first key, and moving on lifts it", async () => {
  const worker = await lab.worker();
  const tab = await login(worker);
  const captain = await Captain.at(lab.chrome, tab.target);

  await captain.click("#pw");
  await until(async () => {
    const reply = await worker.evaluate(tab.session, "document.title");
    return reply.ok ? undefined : reply;
  }, "the guard to refuse while the field has focus");

  await captain.click("#user");
  const lifted = await until(async () => {
    const reply = await worker.evaluate(tab.session, "document.title");
    return reply.ok ? reply : undefined;
  }, "the read to work once focus left the empty field");
  assert.equal(lifted.text, '"login"');
  captain.close();
});

test("a submitted password is not in the worker's network log, and the next page reads normally", async () => {
  const worker = await lab.worker();
  const tab = await login(worker);
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
  const welcome = await until(async () => {
    const reply = await worker.evaluate(tab.session, "document.title");
    return reply.ok && reply.text === '"welcome"' ? reply : undefined;
  }, "the next page to read normally");
  assert.equal(welcome.text, '"welcome"');

  const sent = worker.events.filter((event) => event.method.startsWith("Network."));
  assert.ok(sent.length > 0, "the worker's network log saw nothing");
  assert.ok(
    !JSON.stringify(sent).includes(SECRET),
    "the password is in the worker's network events",
  );
  const request = sent.find(
    (event) =>
      event.method === "Network.requestWillBeSent" && JSON.stringify(event).includes("/submit"),
  );
  const params = request?.params;
  const requestId =
    typeof params === "object" && params !== null && "requestId" in params
      ? String(params.requestId)
      : "";
  const body = await worker.call(tab.session, "Network.getRequestPostData", { requestId });
  assert.equal(body.ok, false);
  assert.ok(!body.text.includes(SECRET));
  captain.close();
});

test("a second worker that attaches to the tab is refused too", async () => {
  const worker = await lab.worker();
  const tab = await login(worker);
  const captain = await Captain.at(lab.chrome, tab.target);
  await captain.click("#pw");
  await captain.type(SECRET);
  const second = await lab.worker();
  const session = await second.attach(tab.target);

  const reply = await until(async () => {
    const answer = await second.evaluate(session, READ_PASSWORD);
    return answer.ok ? undefined : answer;
  }, "a second worker's read to be refused");
  assert.match(reply.text, REFUSED);
  assert.ok(!reply.text.includes(SECRET));
  captain.close();
});

const WAIT_FOR_PASSWORD = `new Promise((resolve) => {
  const field = document.querySelector('#pw');
  field.addEventListener('input', () => {
    if (field.value.length >= ${String(SECRET.length)}) resolve(field.value);
  });
  window.__listening = true;
})`;

const HOLD_PASSWORD = `new Promise((resolve) => {
  const field = document.querySelector('#pw');
  let kept = '';
  field.addEventListener('input', () => {
    if (field.value.length === ${String(SECRET.length)}) kept = field.value;
  });
  window.__release = () => resolve(kept);
  window.__listening = true;
})`;

const WAIT_IN_FIELD = `function (length) {
  window.__listening = true;
  return new Promise((resolve) => {
    this.addEventListener('input', () => {
      if (this.value.length >= length) resolve(this.value);
    });
  });
}`;

const reachedPage = (target: string): Promise<true> =>
  until(
    async () =>
      (await lab.chrome.evaluate(target, "window.__listening === true")) === true
        ? true
        : undefined,
    "the worker's read to reach the page",
  );

async function handleOf(worker: Worker, session: string, expression: string): Promise<string> {
  const found = await worker.cdp.send("Runtime.evaluate", { expression }, { sessionId: session });
  const result = isRecord(found) ? found["result"] : undefined;
  const objectId = isRecord(result) ? optionalString(result, "objectId") : undefined;
  if (objectId === undefined) throw new Error(`${expression} gave no object`);
  return objectId;
}

async function leaveField(captain: Captain): Promise<void> {
  await captain.erase(SECRET.length);
  await captain.click("#user");
}

test("a read that went through before the captain typed is refused when its answer comes after", async () => {
  const worker = await lab.worker();
  const tab = await login(worker);
  const pending = worker.evaluate(tab.session, WAIT_FOR_PASSWORD);
  await reachedPage(tab.target);
  const captain = await Captain.at(lab.chrome, tab.target);
  await captain.click("#pw");
  await captain.type(SECRET);

  const reply = await pending;
  assert.equal(reply.ok, false);
  assert.match(reply.text, REFUSED);
  assert.ok(!reply.text.includes(SECRET));
  await leaveField(captain);
  captain.close();
});

test("a function called on a node before the captain typed is refused when its answer comes after", async () => {
  const worker = await lab.worker();
  const tab = await login(worker);
  const field = await handleOf(worker, tab.session, "document.querySelector('#pw')");
  const pending = worker.call(tab.session, "Runtime.callFunctionOn", {
    objectId: field,
    functionDeclaration: WAIT_IN_FIELD,
    arguments: [{ value: SECRET.length }],
    awaitPromise: true,
    returnByValue: true,
  });
  await reachedPage(tab.target);
  const captain = await Captain.at(lab.chrome, tab.target);
  await captain.click("#pw");
  await captain.type(SECRET);

  const reply = await pending;
  assert.equal(reply.ok, false);
  assert.match(reply.text, REFUSED);
  assert.ok(!reply.text.includes(SECRET));
  await leaveField(captain);
  captain.close();
});

test("a read that waited while the captain typed and emptied the field is refused too", async () => {
  const worker = await lab.worker();
  const tab = await login(worker);
  const pending = worker.evaluate(tab.session, HOLD_PASSWORD);
  await reachedPage(tab.target);
  const captain = await Captain.at(lab.chrome, tab.target);
  await captain.click("#pw");
  await captain.type(SECRET);
  await until(async () => {
    const reply = await worker.evaluate(tab.session, "document.title");
    return reply.ok ? undefined : true;
  }, "the guard to arm");
  await leaveField(captain);
  await reads(worker, tab.session, "document.title", '"login"');
  await lab.chrome.evaluate(tab.target, "window.__release()");

  const reply = await pending;
  assert.equal(reply.ok, false);
  assert.match(reply.text, REFUSED);
  assert.ok(!reply.text.includes(SECRET));
  captain.close();
});

test("a password typed into a cross-origin frame guards the whole tab and the frame", async () => {
  const worker = await lab.worker();
  const tab = await worker.open(lab.site.url("/embed"));
  const frame = await lab.frameOf(tab.target);
  const inFrame = await worker.attach(frame);
  await reads(worker, inFrame, "!!document.querySelector('#pw')", "true");
  const captain = await Captain.at(lab.chrome, tab.target);
  await captain.clickIntoFrame(frame, "#pw", 20, 15);
  await captain.type(SECRET);

  await until(async () => {
    const reply = await worker.evaluate(tab.session, "document.title");
    return reply.ok ? undefined : reply;
  }, "the page to be refused");
  const reply = await worker.evaluate(inFrame, "document.querySelector('#pw').value");
  assert.equal(reply.ok, false);
  assert.match(reply.text, REFUSED);
  assert.ok(!reply.text.includes(SECRET));
  captain.close();
});

test("a worker connected to the page's own socket is guarded too", async () => {
  const worker = await lab.worker();
  const tab = await login(worker);
  const captain = await Captain.at(lab.chrome, tab.target);
  await captain.click("#pw");
  await captain.type(SECRET);
  await until(async () => {
    const reply = await worker.evaluate(tab.session, READ_PASSWORD);
    return reply.ok ? undefined : true;
  }, "the guard to arm");

  const socket = new WebSocket(`${lab.guard.replace("http", "ws")}/devtools/page/${tab.target}`);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => {
      resolve();
    });
    socket.addEventListener("error", () => {
      reject(new Error("the page socket was refused"));
    });
  });
  const answer = new Promise<string>((resolve) => {
    socket.addEventListener("message", (event) => {
      resolve(String(event.data));
    });
  });
  socket.send(
    JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: READ_PASSWORD } }),
  );
  const text = await answer;
  socket.close();
  assert.match(text, REFUSED);
  assert.ok(!text.includes(SECRET));
  captain.close();
});

test("a password that is already in a field when the guard starts is guarded", async () => {
  const worker = await lab.worker();
  const tab = await login(worker);
  const captain = await Captain.at(lab.chrome, tab.target);
  await captain.click("#pw");
  await captain.type(SECRET);
  await until(async () => {
    const reply = await worker.evaluate(tab.session, READ_PASSWORD);
    return reply.ok ? undefined : true;
  }, "the guard to arm");
  worker.close();

  await lab.restartGuard();
  const again = await lab.worker();
  const session = await again.attach(tab.target);
  const reply = await again.evaluate(session, READ_PASSWORD);
  assert.equal(reply.ok, false);
  assert.match(reply.text, REFUSED);
  assert.ok(!reply.text.includes(SECRET));
  await captain.erase(SECRET.length);
  captain.close();
});

function rawGet(path: string, headers: Record<string, string>): Promise<number> {
  const { port } = new URL(lab.proxy);
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: "127.0.0.1", port, path, headers }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.on("error", reject);
    request.end();
  });
}

test("a web page cannot reach the guard, and a rebound host name is refused as Chrome would", async () => {
  assert.equal(await rawGet("/json/version", { origin: "https://evil.example" }), 403);
  assert.equal(await rawGet("/json/version", { host: "evil.example" }), 400);
  assert.equal(
    await rawGet("/json/version", { host: `localhost:${new URL(lab.proxy).port}` }),
    200,
  );
  assert.equal(await rawGet("/devtools/inspector.html", {}), 404);
});

test("the guard follows a Chrome that restarts", async () => {
  await lab.restartChrome();
  const worker = await until(async () => {
    try {
      const connected = await lab.worker();
      await connected.open(lab.site.url("/notes"));
      return connected;
    } catch {
      return undefined;
    }
  }, "a worker to open a tab in the new Chrome");
  const tab = await login(worker);
  const captain = await Captain.at(lab.chrome, tab.target);
  await captain.click("#pw");
  await captain.type(SECRET);
  const reply = await until(async () => {
    const answer = await worker.evaluate(tab.session, READ_PASSWORD);
    return answer.ok ? undefined : answer;
  }, "the guard to arm in the new Chrome");
  assert.match(reply.text, REFUSED);
  captain.close();
});

test("a tool that attaches to every target at once is not held up by the guard", async () => {
  const worker = await lab.worker();
  await worker.open(lab.site.url("/notes"));
  const sessions: string[] = [];
  worker.cdp.listen((event) => {
    const params: unknown = event.params;
    if (event.method === "Target.attachedToTarget" && typeof params === "object" && params !== null)
      if ("sessionId" in params) sessions.push(String(params.sessionId));
  });
  const started = Date.now();
  await worker.cdp.send("Target.setAutoAttach", {
    autoAttach: true,
    waitForDebuggerOnStart: true,
    flatten: true,
    filter: [{ type: "page", exclude: true }, {}],
  });
  await until(() => (sessions.length > 0 ? true : undefined), "the browser to attach the tool");
  for (const session of [...sessions]) {
    assert.equal((await worker.call(session, "Runtime.runIfWaitingForDebugger")).ok, true);
    assert.equal(
      (
        await worker.call(session, "Target.setAutoAttach", {
          autoAttach: true,
          waitForDebuggerOnStart: true,
          flatten: true,
        })
      ).ok,
      true,
    );
  }
  worker.close();
  assert.ok(Date.now() - started < 400, `attaching took ${String(Date.now() - started)} ms`);
});

test("Playwright connects through the guard and works the page", async () => {
  const browser = await chromium.connectOverCDP(lab.guard);
  try {
    const page = await browser.contexts()[0]?.newPage();
    assert.ok(page, "Playwright found no context to open a tab in");
    await page.goto(lab.site.url("/login"));
    await page.fill("#user", "worker");
    assert.equal(await page.evaluate(() => document.title), "login");
    assert.equal(await page.inputValue("#user"), "worker");
    assert.ok((await page.screenshot()).length > 100);
    await page.close();
  } finally {
    await browser.close();
  }
});
