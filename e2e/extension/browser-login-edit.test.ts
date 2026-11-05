import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { BrowserLab, type RawWorker } from "../support/browser-lab.ts";
import { FakeVault } from "../support/fake-vault.ts";
import {
  ALL_VALUES,
  ALT,
  BROKEN,
  CREDENTIAL_SHOWN,
  FIELD,
  FILLED,
  GOOD,
  PASSWORD,
  REFUSAL,
  USERNAME,
  assertNoSecretAnywhere as scan,
  clearedByHand,
  signedIn as signIn,
  until,
} from "../support/login-fixtures.ts";

let vault: FakeVault;
let lab: BrowserLab;

beforeEach(() => {
  vault = new FakeVault([GOOD, { key: "other.test", value: BROKEN }]);
});
afterEach(async () => {
  await lab.stop();
  vault.dispose();
});

async function start(entries = [GOOD, { key: "other.test", value: BROKEN }]): Promise<void> {
  vault.publish(entries);
  lab = await BrowserLab.start({ vault });
}

const assertNoSecretAnywhere = (spoken: readonly string[] = []): void => {
  scan(lab, vault, spoken);
};
const signedIn = (path?: string): Promise<RawWorker> => signIn(lab, path);
const cleared = (worker: RawWorker): Promise<void> => clearedByHand(lab, worker);

test("eval is refused while a login-filled field holds a value, and allowed again once the page moves on", async () => {
  await start();
  const worker = await lab.worker("Sign in to the portal");
  const portal = lab.site.url("/portal", "login.example.test");
  await worker.act({ action: "open", url: portal });
  await worker.act({ action: "login" });

  const reverse = `${FIELD("p")}.value.split("").reverse().join("")`;
  await assert.rejects(worker.act({ action: "eval", expression: reverse }), FILLED);
  await assert.rejects(worker.act({ action: "eval", expression: "location.pathname" }), FILLED);
  assert.equal(await worker.act({ action: "read", selector: "#u-echo" }), "[hidden]");
  assert.match(await worker.act({ action: "open", url: `${portal}#again` }), /^Opened /);
  await assert.rejects(worker.act({ action: "eval", expression: reverse }), FILLED);

  await worker.act({ action: "click", selector: "#submit" });
  const moved = await until(
    () => worker.act({ action: "eval", expression: "location.pathname" }).catch(() => undefined),
    "the page to move on",
  );
  assert.equal(moved, '"/landing"');
  assert.deepEqual(lab.site.posted, [{ username: USERNAME, password: PASSWORD, code: "" }]);

  await worker.act({ action: "open", url: portal });
  await worker.act({ action: "login" });
  await assert.rejects(worker.act({ action: "eval", expression: reverse }), FILLED);
  await worker.act({ action: "open", url: `${portal}?again=1` });
  assert.deepEqual(JSON.parse(await worker.act({ action: "eval", expression: ALL_VALUES })), [
    "",
    "",
  ]);
  assertNoSecretAnywhere();
});

const edit = async (worker: RawWorker, name: string): Promise<void> => {
  await worker.act({ action: "click", selector: `input[name=${name}]` });
  await worker.act({ action: "press", key: "End" });
  await worker.act({ action: "press", key: "Backspace" });
};

const empty = async (worker: RawWorker, name: string): Promise<void> => {
  await worker.act({ action: "type", selector: `input[name=${name}]`, text: "x" });
  await worker.act({ action: "press", key: "Backspace" });
};

test("editing a login-filled field by hand does not release eval or screenshots, emptying every field does", async () => {
  await start();
  const worker = await signedIn();
  await edit(worker, "u");
  await edit(worker, "p");
  await worker.act({ action: "click", selector: "#reveal" });

  await assert.rejects(worker.act({ action: "eval", expression: `${FIELD("p")}.value` }), FILLED);
  await assert.rejects(worker.act({ action: "eval", expression: `${FIELD("u")}.value` }), FILLED);
  await assert.rejects(worker.shoot(), CREDENTIAL_SHOWN);

  await empty(worker, "u");
  await assert.rejects(worker.act({ action: "eval", expression: "location.pathname" }), FILLED);
  await assert.rejects(worker.shoot(), CREDENTIAL_SHOWN);
  await empty(worker, "p");
  assert.deepEqual(JSON.parse(await worker.act({ action: "eval", expression: ALL_VALUES })), [
    "",
    "",
    "",
  ]);
  assert.ok((await worker.shoot()).length > 0);
  assertNoSecretAnywhere();
});

const onPath = async (worker: RawWorker, path: string): Promise<void> => {
  const label = `c-${String(worker.card.id)} `;
  await until(async () => {
    const tab = (await lab.chrome.pages()).find((page) => page.title.startsWith(label));
    if (tab === undefined) return undefined;
    const where = await lab.chrome.evaluate(tab.id, "location.pathname").catch(() => undefined);
    return where === path ? true : undefined;
  }, `the tab to be on ${path}`);
};

const at = (path: string): string => lab.site.url(path, "login.example.test");

const leaving: [string, (worker: RawWorker) => Promise<unknown>][] = [
  ["the form is submitted", (worker) => worker.act({ action: "click", selector: "#submit" })],
  ["open replaces the page", (worker) => worker.act({ action: "open", url: at("/landing") })],
];

for (const [how, leave] of leaving)
  test(`eval stays refused when history restores the login form after ${how}`, async () => {
    await start();
    const worker = await signedIn("/portal");
    await leave(worker);
    await onPath(worker, "/landing");
    await worker.act({ action: "eval", expression: "history.back()" });
    await onPath(worker, "/portal");

    const reverse = `${FIELD("u")}.value.split("").reverse().join("")`;
    await assert.rejects(worker.act({ action: "eval", expression: reverse }), FILLED);
    await assert.rejects(worker.shoot(), CREDENTIAL_SHOWN);

    await worker.act({ action: "open", url: at("/portal?again=1") });
    assert.deepEqual(JSON.parse(await worker.act({ action: "eval", expression: ALL_VALUES })), [
      "",
      "",
    ]);
    assertNoSecretAnywhere();
  });

for (const [how, leave] of leaving)
  test(`the worker's own text in a later page's field does not refuse eval or screenshots after ${how}`, async () => {
    await start();
    const worker = await signedIn("/portal");
    await leave(worker);
    await onPath(worker, "/landing");
    await worker.act({ action: "type", selector: "input[name=q]", text: "weather in paris" });

    assert.equal(
      await worker.act({ action: "eval", expression: FIELD("q") + ".value" }),
      '"weather in paris"',
    );
    assert.ok((await worker.shoot()).length > 0);
    assertNoSecretAnywhere();
  });

test("eval is allowed again once the login-filled field has left the page", async () => {
  await start();
  const worker = await lab.worker("Sign in to the portal");
  await worker.act({ action: "open", url: lab.site.url("/steps", "login.example.test") });
  assert.match(await worker.act({ action: "login" }), /^filled: Filled the username\./);
  await assert.rejects(worker.act({ action: "eval", expression: `${FIELD("u")}.value` }), FILLED);

  await worker.act({ action: "click", selector: "#next" });

  assert.equal(
    await worker.act({ action: "eval", expression: 'document.getElementById("two").textContent' }),
    '"step two"',
  );
  assertNoSecretAnywhere();
});

test("after cardd restarts with the tab kept, eval and screenshots still refuse the values until the fields are empty", async () => {
  await start([GOOD, ALT]);
  const before = await signedIn();
  await lab.cardd.restart();
  const worker = await lab.reconnect(before);

  await assert.rejects(worker.act({ action: "eval", expression: `${FIELD("p")}.value` }), FILLED);
  await assert.rejects(worker.act({ action: "eval", expression: `${FIELD("u")}.value` }), FILLED);
  await assert.rejects(worker.shoot(), CREDENTIAL_SHOWN);
  const login = lab.site.url("/login", "login.example.test");
  assert.match(await worker.act({ action: "open", url: `${login}#again` }), /^Opened /);
  await assert.rejects(worker.act({ action: "eval", expression: `${FIELD("p")}.value` }), FILLED);
  await cleared(worker);
  assert.deepEqual(JSON.parse(await worker.act({ action: "eval", expression: ALL_VALUES })), [
    "",
    "",
    "",
  ]);
  assert.ok((await worker.shoot()).length > 0);
  assert.equal(vault.invocations().length, 4);
  assertNoSecretAnywhere();
});

test("after cardd restarts with the tab kept, a hand-edited login field still refuses eval and screenshots until it is empty", async () => {
  await start();
  const before = await signedIn();
  await lab.cardd.restart();
  const worker = await lab.reconnect(before);
  await edit(worker, "u");
  await edit(worker, "p");

  await assert.rejects(worker.act({ action: "eval", expression: `${FIELD("p")}.value` }), FILLED);
  await assert.rejects(worker.shoot(), CREDENTIAL_SHOWN);

  await empty(worker, "u");
  await assert.rejects(worker.act({ action: "eval", expression: `${FIELD("p")}.value` }), FILLED);
  await empty(worker, "p");
  assert.deepEqual(JSON.parse(await worker.act({ action: "eval", expression: ALL_VALUES })), [
    "",
    "",
    "",
  ]);
  assert.ok((await worker.shoot()).length > 0);
  assertNoSecretAnywhere();
});

test("after cardd restarts with the tab kept, text read from the page still hides the values", async () => {
  await start();
  const before = await signedIn("/echo");
  await lab.cardd.restart();
  const worker = await lab.reconnect(before);

  const seen = [
    await worker.act({ action: "read", selector: "#u-echo" }),
    await worker.act({ action: "read", selector: "#p-echo" }),
    await worker.act({ action: "read" }),
  ];
  assert.deepEqual(
    [seen[0], seen[1], seen[2]?.replace(/\s+/g, " ").trim()],
    ["[hidden]", "[hidden]", "[hidden] [hidden]"],
  );
  assertNoSecretAnywhere(seen);
});

test("after cardd restarts and the vault cannot be read, nothing from the tab is returned", async () => {
  await start();
  const before = await signedIn("/echo");
  await lab.cardd.restart();
  const worker = await lab.reconnect(before);
  vault.revoke();

  await assert.rejects(worker.act({ action: "read" }), REFUSAL);
  await assert.rejects(worker.act({ action: "eval", expression: `${FIELD("p")}.value` }), REFUSAL);
  await assert.rejects(worker.shoot(), REFUSAL);
  assertNoSecretAnywhere();

  vault.restore();
  assert.equal(await worker.act({ action: "read", selector: "#p-echo" }), "[hidden]");
});
