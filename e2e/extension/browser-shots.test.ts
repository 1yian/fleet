import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { BrowserLab, type RawWorker } from "../support/browser-lab.ts";
import { FakeVault } from "../support/fake-vault.ts";
import {
  ALT,
  ALT_PASSWORD,
  ALT_USER,
  FIELD,
  GOOD,
  RETYPE,
  assertNoSecretAnywhere as scan,
  hidden,
  retext,
  signedIn as signIn,
  tabOf as tabIn,
} from "../support/login-fixtures.ts";

let vault: FakeVault;
let lab: BrowserLab;

beforeEach(() => {
  vault = new FakeVault([]);
});
afterEach(async () => {
  await lab.stop();
  vault.dispose();
});

async function start(isolated = false): Promise<void> {
  vault.publish([GOOD, ALT]);
  lab = await BrowserLab.start({ vault, isolated });
}

const assertNoSecretAnywhere = (): void => {
  scan(lab, vault);
};
const signedIn = (path: string): Promise<RawWorker> => signIn(lab, path);

const LAST_CHILD = "document.documentElement.lastElementChild.tagName";

test("a screenshot shows neither the fields nor the text a page echoes from them", async () => {
  await start();
  const worker = await signedIn("/echo");
  const covered = await worker.shoot();
  assert.notEqual(await lab.chrome.capture(await tabIn(lab, worker)), covered);
  assert.equal(await worker.act({ action: "read", selector: "#u-echo" }), "[hidden]");
  assert.equal(await worker.act({ action: "eval", expression: LAST_CHILD }), hidden("BODY"));

  await worker.act({ action: "eval", expression: RETYPE });
  await worker.act({
    action: "eval",
    expression: `${retext("u-echo", ALT_USER)}; ${retext("p-echo", ALT_PASSWORD)}`,
  });
  assert.equal(await worker.shoot(), covered);
  assertNoSecretAnywhere();
});

test("a screenshot after a login that failed halfway shows no echoed value either", async () => {
  await start();
  const worker = await lab.worker("Sign in to the portal");
  await worker.act({ action: "open", url: lab.site.url("/fragile", "login.example.test") });
  await assert.rejects(worker.act({ action: "login" }), /^Error: login failed: /);
  const covered = await worker.shoot();

  await worker.act({
    action: "eval",
    expression: `${FIELD("u")}.value = "${ALT_USER}"; ${retext("u-echo", ALT_USER)}`,
  });
  assert.equal(await worker.shoot(), covered);
  assertNoSecretAnywhere();
});

test("a screenshot hides a value that the page splits across inline elements", async () => {
  await start();
  const worker = await signedIn("/split");
  assert.equal(
    await worker.act({
      action: "eval",
      expression: "document.getElementById('who').children.length",
    }),
    "1",
  );
  const covered = await worker.shoot();
  assert.notEqual(await lab.chrome.capture(await tabIn(lab, worker)), covered);

  await worker.act({ action: "eval", expression: `window.show("${ALT_USER}")` });
  assert.equal(await worker.shoot(), covered);
  assertNoSecretAnywhere();
});

test("a screenshot hides a value that the page rewrites all the time", async () => {
  await start();
  const worker = await signedIn("/tick");
  const covered = await worker.shoot();
  assert.notEqual(await lab.chrome.capture(await tabIn(lab, worker)), covered);

  await worker.act({ action: "eval", expression: `window.set("${ALT_USER}")` });
  assert.equal(await worker.shoot(), covered);
  assert.equal(await worker.act({ action: "eval", expression: LAST_CHILD }), hidden("BODY"));
  assertNoSecretAnywhere();
});

test("a screenshot shows no value inside an iframe, a cross-site iframe, or an open shadow root", async () => {
  await start(true);
  const worker = await signedIn("/nest");
  await worker.act({ action: "eval", expression: "window.framesReady.then(() => 'ready')" });
  const covered = await worker.shoot();
  assert.equal(
    await worker.act({
      action: "eval",
      expression: `document.getElementById("same").contentDocument.getElementById("who").textContent`,
    }),
    hidden("[hidden]"),
  );

  await worker.act({ action: "eval", expression: RETYPE });
  await worker.act({
    action: "eval",
    expression: `window.show("${ALT_USER}", "${ALT_USER}").then(() => "ready")`,
  });
  assert.equal(await worker.shoot(), covered);
  assertNoSecretAnywhere();
});

test("a full-page screenshot hides a value below the fold", async () => {
  await start();
  const worker = await signedIn("/tall");
  const covered = await worker.shoot(true);
  assert.ok(Buffer.from(covered, "base64").readUInt32BE(20) > 1400);

  await worker.act({ action: "eval", expression: retext("who", ALT_USER) });
  assert.equal(await worker.shoot(true), covered);
  assertNoSecretAnywhere();
});

test("a screenshot of a page whose value moves by a CSS animation shows it nowhere", async () => {
  await start();
  const worker = await signedIn("/slide");
  const covered = await worker.shoot();
  assert.notEqual(await lab.chrome.capture(await tabIn(lab, worker)), covered);

  await worker.act({ action: "eval", expression: retext("who", ALT_USER) });
  assert.equal(await worker.shoot(), covered);
  assert.equal(await worker.act({ action: "eval", expression: LAST_CHILD }), hidden("BODY"));
  assertNoSecretAnywhere();
});

test("a screenshot hides a value that a pseudo-element draws from an attribute", async () => {
  await start();
  const worker = await signedIn("/pseudo");
  const covered = await worker.shoot();
  assert.notEqual(await lab.chrome.capture(await tabIn(lab, worker)), covered);

  await worker.act({
    action: "eval",
    expression: `document.getElementById("who").setAttribute("data-account", "${ALT_USER}")`,
  });
  assert.equal(await worker.shoot(), covered);
  assertNoSecretAnywhere();
});

test("a screenshot hides a value that a closed shadow root holds", async () => {
  await start();
  const worker = await signedIn("/closed");
  const covered = await worker.shoot();
  assert.notEqual(await lab.chrome.capture(await tabIn(lab, worker)), covered);

  await worker.act({ action: "eval", expression: `window.hold("${ALT_USER}")` });
  assert.equal(await worker.shoot(), covered);
  assertNoSecretAnywhere();
});
