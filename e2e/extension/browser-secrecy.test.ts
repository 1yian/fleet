import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { BrowserLab, type RawWorker } from "../support/browser-lab.ts";
import { FakeVault } from "../support/fake-vault.ts";
import {
  ALL_VALUES,
  ALT,
  CREDENTIAL_SHOWN,
  FIELD,
  GOOD,
  OTHER,
  OTHER_USER,
  REFUSAL,
  USERNAME,
  WITH_TRICKY,
  assertNoSecretAnywhere as scan,
  retext,
  signedIn as signIn,
  until,
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

async function start(entries = [GOOD], isolated = false): Promise<void> {
  vault.publish(entries);
  lab = await BrowserLab.start({ vault, isolated });
}

const assertNoSecretAnywhere = (spoken: readonly string[] = []): void => {
  scan(lab, vault, spoken);
};
const signedIn = (path?: string): Promise<RawWorker> => signIn(lab, path);

const account = (who: string, host: string): string =>
  lab.site.url(`/account?as=${encodeURIComponent(who)}`, host);

test("a password the page serialized itself does not come back through eval", async () => {
  await start([WITH_TRICKY]);
  const worker = await signedIn();
  const once = `JSON.stringify({ password: ${FIELD("p")}.value })`;
  const seen = [
    await worker.act({ action: "eval", expression: once }),
    await worker.act({ action: "eval", expression: `JSON.stringify([${once}])` }),
    await worker.act({
      action: "eval",
      expression: `JSON.stringify({ deep: [${once}], again: JSON.stringify(${once}) })`,
    }),
  ];
  assert.equal(JSON.parse(seen[0] ?? ""), '{"password":"[hidden]"}');
  assert.match(seen[1] ?? "", /\[hidden\]/);
  assert.match(seen[2] ?? "", /\[hidden\]/);
  assertNoSecretAnywhere(seen);
});

test("a replacement page never receives a value, even when it commits in the middle of the fill", async () => {
  await start();
  const worker = await lab.worker("Sign in to the portal");
  await worker.act({ action: "open", url: lab.site.url("/sso", "login.example.test") });
  const outcome = await worker.act({ action: "login" }).then(
    (text) => text,
    (error: unknown) => String(error),
  );
  await until(
    async () =>
      (await worker.act({ action: "eval", expression: "location.pathname" })) === '"/landing"'
        ? true
        : undefined,
    "the redirect to commit",
  );

  assert.match(
    outcome,
    /^(filled: |Error: login failed: the page changed from login\.example\.test to login\.evil\.test)/,
  );
  assert.deepEqual(JSON.parse(await worker.act({ action: "eval", expression: ALL_VALUES })), [""]);
  assertNoSecretAnywhere();
});

test("opening a page on a tab that outlived a cardd restart hides the values in its title and address", async () => {
  await start([GOOD, OTHER]);
  const before = await signedIn();
  await lab.cardd.restart();
  const worker = await lab.reconnect(before);

  const there = await worker.act({
    action: "open",
    url: account(OTHER_USER, "login.nothing.test"),
  });
  const here = await worker.act({ action: "open", url: account(USERNAME, "login.example.test") });

  assert.match(
    there,
    /^Opened "c-1 .*Account of \[hidden\]" at http:\/\/login\.nothing\.test:\d+\/account\?as=\[hidden\] in your tab /,
  );
  assert.match(
    here,
    /^Opened "c-1 .*Account of \[hidden\]" at http:\/\/login\.example\.test:\d+\/account\?as=\[hidden\] in your tab /,
  );
  assert.equal(vault.invocations().length, 4);
  assertNoSecretAnywhere([there, here]);
});

test("opening a page on a tab that outlived a cardd restart is refused when the vault cannot be read", async () => {
  await start();
  const before = await signedIn();
  await lab.cardd.restart();
  const worker = await lab.reconnect(before);
  vault.revoke();

  await assert.rejects(
    worker.act({ action: "open", url: account("someone", "login.example.test") }),
    REFUSAL,
  );
  assert.deepEqual(
    (await lab.chrome.pages()).map((page) => new URL(page.url).pathname),
    ["/login"],
  );
  assertNoSecretAnywhere();

  vault.restore();
  assert.match(
    await worker.act({ action: "open", url: account("someone", "login.example.test") }),
    /^Opened "c-1 .*Account of someone" at /,
  );
});

test("a username stays hidden when its entry has no password, also after a cardd restart", async () => {
  await start([
    { key: "example.test", value: JSON.stringify({ username: USERNAME, password: "" }) },
    ALT,
  ]);
  const before = await lab.worker("Look at the account");
  await before.act({ action: "open", url: account(USERNAME, "login.example.test") });
  await lab.cardd.restart();
  const worker = await lab.reconnect(before);

  const seen = [
    await worker.act({ action: "read", selector: "#who" }),
    await worker.act({ action: "eval", expression: "document.title" }),
  ];
  await assert.rejects(worker.shoot(), CREDENTIAL_SHOWN);
  await worker.act({ action: "eval", expression: retext("who", "someone") });
  assert.ok((await worker.shoot()).length > 0);
  await worker.act({ action: "eval", expression: retext("who", USERNAME) });
  seen.push(await worker.act({ action: "open", url: account(USERNAME, "login.example.test") }));

  assert.equal(seen[0], "[hidden]");
  assert.match(seen[1] ?? "", /Account of \[hidden\]"$/);
  assert.match(
    seen[2] ?? "",
    /^Opened "c-1 .*Account of \[hidden\]" at .*\?as=\[hidden\] in your tab /,
  );
  assertNoSecretAnywhere(seen);
});

test("an entry with a field that is neither text nor empty stops the browser until it is fixed", async () => {
  await start([
    { key: "example.test", value: JSON.stringify({ username: USERNAME, password: ["x"] }) },
  ]);
  const worker = await lab.worker("Look at the account");
  await assert.rejects(
    worker.act({ action: "open", url: account("someone", "login.example.test") }),
    REFUSAL,
  );
  assert.deepEqual(await lab.chrome.pages(), []);

  vault.publish([GOOD]);
  assert.match(
    await worker.act({ action: "open", url: account("someone", "login.example.test") }),
    /^Opened /,
  );
});

const MALFORMED =
  /^Error: the Logins project could not be read to learn which values to hide, so nothing was done: the Bitwarden entry example\.test is malformed/;

test("a truncated entry makes every action that returns content refuse after a cardd restart", async () => {
  await start([GOOD]);
  const before = await lab.worker("Look at the account");
  await before.act({ action: "open", url: account(USERNAME, "login.example.test") });
  vault.publish([{ key: "example.test", value: `{"username":"${USERNAME}","password":` }]);
  await lab.cardd.restart();
  const worker = await lab.reconnect(before);

  await assert.rejects(worker.act({ action: "read", selector: "#who" }), MALFORMED);
  await assert.rejects(worker.act({ action: "eval", expression: "document.title" }), MALFORMED);
  await assert.rejects(worker.shoot(), MALFORMED);
  await assert.rejects(
    worker.act({ action: "open", url: account(USERNAME, "login.example.test") }),
    MALFORMED,
  );
  assertNoSecretAnywhere();

  vault.publish([GOOD]);
  assert.equal(await worker.act({ action: "read", selector: "#who" }), "[hidden]");
});

test("a read that fails after a good load stops the next action until a read succeeds", async () => {
  await start();
  const worker = await lab.worker("Look at the account");
  await worker.act({ action: "open", url: account("someone", "login.example.test") });
  vault.revoke();

  await assert.rejects(worker.act({ action: "login" }), /bws could not read the Logins project/);
  await assert.rejects(worker.act({ action: "read" }), REFUSAL);
  await assert.rejects(worker.shoot(), REFUSAL);

  vault.restore();
  assert.equal(await worker.act({ action: "read", selector: "#who" }), "someone");
});

const OUTPUT_REFUSED =
  /^Error: this output contains a stored credential; read it as text, which hides it$/;

async function splitPage(): Promise<RawWorker> {
  await start();
  const worker = await signedIn("/places?at=split");
  await worker.act({ action: "eval", expression: "window.ready" });
  await worker.act({
    action: "eval",
    expression: `[...document.querySelectorAll('input')].forEach((el) => { el.value = ''; })`,
  });
  return worker;
}

for (const [name, action] of [
  ["read with html", { action: "read", selector: "#spot", html: true }],
  ["eval of outerHTML", { action: "eval", expression: "document.documentElement.outerHTML" }],
  [
    "eval of innerHTML",
    { action: "eval", expression: "document.getElementById('spot').innerHTML" },
  ],
  [
    "eval of an object that holds HTML",
    {
      action: "eval",
      expression: "({ n: 1, parts: { html: document.getElementById('spot').innerHTML } })",
    },
  ],
  [
    "eval of JSON text that holds HTML",
    {
      action: "eval",
      expression: "JSON.stringify({ html: document.getElementById('spot').innerHTML })",
    },
  ],
] as const)
  test(`${name} is refused when the page splits the username across elements`, async () => {
    const worker = await splitPage();
    await assert.rejects(worker.act(action), OUTPUT_REFUSED);

    const text = await worker.act({ action: "read", selector: "#spot" });
    assert.equal(text, "[hidden]");
    await worker.act({ action: "eval", expression: 'window.put("someone")' });
    assert.match(
      await worker.act({ action: "read", selector: "#spot", html: true }),
      /^<div id="spot"><p>so<strong>me<\/strong>one<\/p><\/div>$/,
    );
    assertNoSecretAnywhere();
  });
