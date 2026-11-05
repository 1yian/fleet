import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { BrowserLab, type RawWorker } from "../support/browser-lab.ts";
import { FakeVault } from "../support/fake-vault.ts";
import {
  ALL_VALUES,
  ALT,
  CREDENTIAL_SHOWN,
  FIELD,
  FILLED,
  GOOD,
  OTHER,
  OTHER_USER,
  REFUSAL,
  USERNAME,
  WITH_TRICKY,
  assertNoSecretAnywhere as scan,
  clearedByHand,
  retext,
  signedIn as signIn,
  tabOf as tabIn,
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
const cleared = (worker: RawWorker): Promise<void> => clearedByHand(lab, worker);

const pathOf = (worker: RawWorker): Promise<string> =>
  worker.act({ action: "eval", expression: "location.pathname" }).catch(() => "");

const account = (who: string, host: string): string =>
  lab.site.url(`/account?as=${encodeURIComponent(who)}`, host);

test("a password the page serialized itself does not come back through eval", async () => {
  await start([WITH_TRICKY]);
  const worker = await signedIn("/echo");
  await cleared(worker);
  const once = `JSON.stringify({ password: document.getElementById("p-echo").textContent })`;
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
    async () => ((await pathOf(worker)) === '"/landing"' ? true : undefined),
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
  await cleared(worker);
  await worker.act({ action: "eval", expression: "window.ready" });
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

const MARKED = {
  key: "example.test",
  value: JSON.stringify({ username: "mark", password: "hunter2" }),
};
const COPIED = {
  key: "copy.test",
  value: JSON.stringify({ username: "copyuser-x91", password: "S3cret\u00a92026" }),
};

const ENCODED = {
  key: "encoded.test",
  value: JSON.stringify({ username: "\u674e", password: "S3cret\u00a92026" }),
};

const nothingOf = (...secrets: string[]): void => {
  const places = [lab.cardd.output, lab.cardd.errors, vault.invocations().join("\n")];
  for (const place of places)
    for (const secret of secrets) assert.equal(place.includes(secret), false);
};

test("HTML that splits a password around a tag named like the username is refused whole", async () => {
  await start([MARKED]);
  const worker = await lab.worker("Look at the page");
  await worker.act({ action: "open", url: lab.site.url("/composed", "login.example.test") });

  for (const action of [
    { action: "read", selector: "#who", html: true },
    { action: "eval", expression: "document.getElementById('who').outerHTML" },
    { action: "eval", expression: "document.documentElement.outerHTML" },
  ] as const)
    await assert.rejects(worker.act(action), OUTPUT_REFUSED);

  assert.equal(await worker.act({ action: "read", selector: "#who" }), "[hidden]");
  nothingOf("hunter2");
});

test("a password that the page source writes with a named character reference is refused", async () => {
  await start([COPIED]);
  const worker = await lab.worker("Look at the page");
  await worker.act({ action: "open", url: lab.site.url("/copy", "login.example.test") });

  await assert.rejects(
    worker.act({ action: "eval", expression: "fetch(location.href).then((r) => r.text())" }),
    OUTPUT_REFUSED,
  );
  assert.equal(await worker.act({ action: "read", selector: "#who" }), "[hidden]");
  assert.equal(
    await worker.act({ action: "read", selector: "#who", html: true }),
    '<div id="who">[hidden]</div>',
  );
  await assert.rejects(worker.shoot(), CREDENTIAL_SHOWN);
  nothingOf("S3cret", "copyuser-x91");
});

for (const [name, path, html] of [
  [
    "a character reference in an attribute value",
    "/copy-attribute",
    '<input id="who" value="[hidden]">',
  ],
  ["a numeric reference with leading zeros", "/copy-padded", '<div id="who">[hidden]</div>'],
  ["a username that is one character reference", "/copy-single", '<div id="who">[hidden]</div>'],
] as const)
  test(`${name} in the page source is refused`, async () => {
    await start([ENCODED]);
    const worker = await lab.worker("Look at the page");
    await worker.act({ action: "open", url: lab.site.url(path, "login.example.test") });

    await assert.rejects(
      worker.act({ action: "eval", expression: "fetch(location.href).then((r) => r.text())" }),
      OUTPUT_REFUSED,
    );
    assert.equal(await worker.act({ action: "read", selector: "#who", html: true }), html);
    await assert.rejects(worker.shoot(), CREDENTIAL_SHOWN);
    nothingOf("S3cret", "\u674e");
  });

test("login reports a password field that rewrites what is typed into it as failed and empties it", async () => {
  await start();
  const worker = await lab.worker("Sign in to the portal");
  await worker.act({ action: "open", url: lab.site.url("/masked", "login.example.test") });

  await assert.rejects(
    worker.act({ action: "login" }),
    /^Error: login failed: the page did not keep the password that was typed into it$/,
  );
  assert.equal(await lab.chrome.evaluate(await tabIn(lab, worker), `${FIELD("p")}.value`), "");
  await assert.rejects(worker.act({ action: "eval", expression: `${FIELD("u")}.value` }), FILLED);
  assertNoSecretAnywhere();
});
