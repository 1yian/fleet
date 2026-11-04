import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { BrowserLab, browse, results } from "../support/browser-lab.ts";
import { FakeVault } from "../support/fake-vault.ts";
import type { Turn } from "../support/harness.ts";
import {
  ALL_VALUES,
  ALT,
  BROKEN,
  CLEAR_FIELDS,
  CREDENTIAL_SHOWN,
  FIELD,
  GOOD,
  OTHER,
  OTHER_USER,
  PASSWORD,
  REFUSAL,
  USERNAME,
  WITH_TRICKY,
  assertNoSecretAnywhere as scan,
  hidden,
  retext,
  signedIn as signIn,
  tabOf as tabIn,
  until,
} from "../support/login-fixtures.ts";
import type { RawWorker } from "../support/browser-lab.ts";

let vault: FakeVault;
let lab: BrowserLab;

beforeEach(() => {
  vault = new FakeVault([GOOD, { key: "other.test", value: BROKEN }]);
});
afterEach(async () => {
  await lab.stop();
  vault.dispose();
});

async function start(
  entries = [GOOD, { key: "other.test", value: BROKEN }],
  logins: Record<string, unknown> = {},
): Promise<void> {
  vault.publish(entries);
  lab = await BrowserLab.start({ vault, logins });
}

const heard = (turns: readonly Turn[][]): string => JSON.stringify(turns);
const assertNoSecretAnywhere = (spoken: readonly string[] = []): void => {
  scan(lab, vault, spoken);
};
const signedIn = (path?: string): Promise<RawWorker> => signIn(lab, path);
const tabOf = (worker: RawWorker): Promise<string> => tabIn(lab, worker);

test("login fills the page's username and password without the worker ever seeing them", async () => {
  await start();
  const worker = await lab.crew("Sign in to the portal");
  const login = lab.site.url("/login", "login.example.test");
  browse(worker.h, { action: "open", url: login });
  browse(worker.h, { action: "login" });
  browse(worker.h, { action: "eval", expression: "document.querySelector('input[name=c]').value" });
  browse(worker.h, { action: "eval", expression: "document.querySelector('input[name=p]').value" });
  browse(worker.h, { action: "eval", expression: "document.querySelector('input[name=u]').value" });
  browse(worker.h, { action: "click", selector: "#submit" });
  browse(worker.h, { action: "read", selector: "#msg" });
  worker.h.onModel(() => ({ tool: "report", args: { status: "done", text: "signed in" } }));

  const seen = results(await worker.h.waitForCall(7));

  assert.equal(
    seen[1],
    "filled: Filled the username and password. The entry has a one-time-code seed, which the fleet does not fill yet. Entry: example.test.",
  );
  assert.equal(seen[2], '""');
  assert.equal(seen[3], '"[hidden]"');
  assert.equal(seen[4], '"[hidden]"');
  assert.equal(seen[6], "Welcome back");
  assert.deepEqual(lab.site.posted, [{ username: USERNAME, password: PASSWORD, code: "" }]);
  assert.equal(vault.invocations().length, 2);
  for (const call of vault.invocations())
    assert.match(call, /^secret list [0-9a-f-]{36} --output json$/);
  assertNoSecretAnywhere([heard(worker.h.calls)]);
});

test("a site with no entry is reported not found, asks the mate once, and works after it is added", async () => {
  await start();
  const worker = await lab.crew("Sign in to the portal");
  const page = lab.site.url("/login", "login.nothing.test");
  browse(worker.h, { action: "open", url: page });
  browse(worker.h, { action: "login" });
  browse(worker.h, { action: "login" });
  browse(worker.h, { action: "eval", expression: "document.querySelector('input[name=p]').value" });
  worker.h.onModel(() => ({
    tool: "report",
    args: { status: "paused", text: "waiting for a login" },
  }));

  const seen = results(await worker.h.waitForCall(4));

  assert.equal(
    seen[1],
    "not found: the Logins project has no entry for login.nothing.test, and I asked your mate to have one added. Nothing was filled. Wait for the captain to add it (report paused or blocked until then), then call login again.",
  );
  assert.match(seen[2] ?? "", /your mate was already asked/);
  assert.equal(seen[3], '""');
  const asked = lab.main.entries
    .map(({ entry }) => entry)
    .filter((entry) => entry.author === "browser");
  assert.equal(asked.length, 1);
  assert.match(
    asked[0]?.body ?? "",
    new RegExp(
      `^c-${String(worker.card.id)} needs a Bitwarden login for login\\.nothing\\.test\\. Ask the captain to add one secret`,
    ),
  );
  assert.equal(asked[0]?.fields["for"], "mate");
  assertNoSecretAnywhere([heard(worker.h.calls)]);
});

test("a login added after the request is used on the next call", async () => {
  await start([]);
  const worker = await lab.crew("Sign in to the portal");
  const page = lab.site.url("/login", "login.nothing.test");
  browse(worker.h, { action: "open", url: page });
  browse(worker.h, { action: "login" });
  worker.h.onModel(() => ({ tool: "report", args: { status: "paused", text: "waiting" } }));
  worker.h.onModel(() => ({ text: "waiting for the captain" }));
  browse(worker.h, { action: "login" });
  browse(worker.h, { action: "click", selector: "#submit" });
  worker.h.onModel(() => ({ tool: "report", args: { status: "done", text: "signed in" } }));
  assert.match(results(await worker.h.waitForCall(3)).at(-2) ?? "", /^not found:/);
  await lab.main.waitForEntry((entry) => entry.author === "browser", "the request to the mate");

  vault.publish([{ key: "nothing.test", value: GOOD.value }]);
  await lab.main.call("comment", { card: worker.card.id, text: "added: try login again" });
  const seen = results(await worker.h.waitForCall(6));

  assert.match(seen.at(-2) ?? "", /^filled: Filled the username and password\./);
  assert.deepEqual(lab.site.posted, [{ username: USERNAME, password: PASSWORD, code: "" }]);
  assertNoSecretAnywhere([heard(worker.h.calls)]);
});

test("login never fills a page that is not the site, and says why", async () => {
  await start();
  const worker = await lab.crew("Sign in to the portal");
  browse(worker.h, { action: "open", url: lab.site.url("/login", "login.evil.test") });
  browse(worker.h, { action: "login", site: "example.test" });
  worker.h.onModel(() => ({ tool: "report", args: { status: "blocked", text: "wrong page" } }));

  const seen = results(await worker.h.waitForCall(2));

  assert.equal(
    seen[1],
    "your tab is on login.evil.test, not example.test: open example.test's login page first",
  );
  assert.equal(vault.invocations().length, 1);
  assert.deepEqual(lab.site.posted, []);
});

test("a vault that refuses the machine account stops the browser before anything is opened", async () => {
  await start();
  vault.revoke();
  const worker = await lab.crew("Sign in to the portal");
  browse(worker.h, { action: "open", url: lab.site.url("/login", "login.example.test") });
  worker.h.onModel(() => ({ tool: "report", args: { status: "blocked", text: "no vault" } }));
  const seen = results(await worker.h.waitForCall(2));
  assert.equal(
    seen[0],
    "the Logins project could not be read to learn which values to hide, so nothing was done: bws could not read the Logins project on p620: Error: the access token is not valid. Try again when the vault answers",
  );
  assert.deepEqual(await lab.chrome.pages(), []);
  assert.deepEqual(lab.site.posted, []);
});

test("a vault that fails while login reads it is reported as failed with its reason", async () => {
  await start();
  const worker = await lab.crew("Sign in to the portal");
  browse(worker.h, { action: "open", url: lab.site.url("/login", "login.example.test") });
  worker.h.onModel(() => {
    vault.revoke();
    return { tool: "browser", args: { action: "login" } };
  });
  worker.h.onModel(() => ({ tool: "report", args: { status: "blocked", text: "no vault" } }));
  const seen = results(await worker.h.waitForCall(3));
  assert.equal(
    seen[1],
    "bws could not read the Logins project on p620: Error: the access token is not valid",
  );
  assert.deepEqual(lab.site.posted, []);
});

test("an entry that is not usable is reported as failed without its content", async () => {
  await start([{ key: "example.test", value: BROKEN }]);
  const worker = await lab.crew("Sign in to the portal");
  browse(worker.h, { action: "open", url: lab.site.url("/login", "login.example.test") });
  browse(worker.h, { action: "login" });
  worker.h.onModel(() => ({ tool: "report", args: { status: "blocked", text: "bad entry" } }));
  const seen = results(await worker.h.waitForCall(2));
  assert.equal(
    seen[1],
    'the Bitwarden entry example.test is not usable: its value must be JSON like {"username": "...", "password": "..."}. Its content is not shown',
  );
  assertNoSecretAnywhere([heard(worker.h.calls)]);
});

test("a screenshot after login is refused, also after a show-password toggle, and leaves the fields alone", async () => {
  await start([GOOD, ALT]);
  const worker = await signedIn();
  await worker.act({ action: "eval", expression: 'document.getElementById("reveal").click()' });
  assert.equal(await worker.act({ action: "eval", expression: `${FIELD("p")}.type` }), '"text"');

  await assert.rejects(worker.shoot(), CREDENTIAL_SHOWN);
  const styles = await worker.act({
    action: "eval",
    expression: "[...document.querySelectorAll('input')].map((el) => el.style.length)",
  });
  assert.deepEqual(JSON.parse(styles), [0, 0, 0]);
  assertNoSecretAnywhere();
});

test("a password with quotes and backslashes does not come back through eval", async () => {
  await start([WITH_TRICKY]);
  const worker = await signedIn();
  const seen = [
    await worker.act({ action: "eval", expression: `${FIELD("p")}.value` }),
    await worker.act({
      action: "eval",
      expression: `({ p: ${FIELD("p")}.value, all: ${ALL_VALUES} })`,
    }),
    await worker.act({
      action: "eval",
      expression: `new URLSearchParams({ p: ${FIELD("p")}.value }).toString()`,
    }),
    await worker.act({
      action: "eval",
      expression: `history.replaceState(null, "", "#" + encodeURIComponent(${FIELD("p")}.value)); location.href`,
    }),
  ];
  assert.equal(seen[0], hidden("[hidden]"));
  assert.deepEqual(JSON.parse(seen[1] ?? ""), { p: "[hidden]", all: ["[hidden]", "[hidden]", ""] });
  assert.equal(seen[2], hidden("p=[hidden]"));
  assert.match(seen[3] ?? "", /\/login#\[hidden\]"$/);
  assertNoSecretAnywhere(seen);
});

test("a login that fails halfway leaves nothing readable", async () => {
  await start();
  const worker = await lab.worker("Sign in to the portal");
  await worker.act({ action: "open", url: lab.site.url("/fragile", "login.example.test") });
  await assert.rejects(
    worker.act({ action: "login" }),
    /^Error: login failed: the password field left the page before it could be filled, so it was not typed$/,
  );
  const seen = [
    await worker.act({ action: "read", selector: "#u-echo" }),
    await worker.act({ action: "eval", expression: `${FIELD("u")}.value` }),
    await worker.act({ action: "eval", expression: `${FIELD("u")}.value.length` }),
  ];
  assert.deepEqual(seen, ["[hidden]", hidden("[hidden]"), String(USERNAME.length)]);
  assertNoSecretAnywhere(seen);
});

test("login types nothing when the page moves to another host during the vault lookup", async () => {
  await start();
  const worker = await lab.worker("Sign in to the portal");
  await worker.act({ action: "open", url: lab.site.url("/login", "login.example.test") });
  vault.hold();
  const pending = worker.act({ action: "login" }).then(
    (text) => text,
    (error: unknown) => String(error),
  );
  await until(() => (vault.invocations().length === 1 ? true : undefined), "the vault lookup");
  await lab.chrome.navigate(await tabOf(worker), lab.site.url("/echo", "login.evil.test"));
  await vault.release();

  assert.match(
    await pending,
    /^Error: login failed: the page changed from login\.example\.test to login\.evil\.test while the login was being filled, so nothing was typed into the new page\./,
  );
  assert.equal(
    await worker.act({ action: "eval", expression: "location.hostname" }),
    '"login.evil.test"',
  );
  assert.deepEqual(JSON.parse(await worker.act({ action: "eval", expression: ALL_VALUES })), [
    "",
    "",
  ]);
  assert.deepEqual(lab.site.posted, []);
  assertNoSecretAnywhere();
});

test("after cardd restarts with the tab kept, eval and screenshots still hide the values", async () => {
  await start([GOOD, ALT]);
  const before = await signedIn();
  await lab.cardd.restart();
  const worker = await lab.reconnect(before);

  assert.equal(
    await worker.act({ action: "eval", expression: `${FIELD("p")}.value` }),
    hidden("[hidden]"),
  );
  assert.equal(
    await worker.act({ action: "eval", expression: `${FIELD("u")}.value` }),
    hidden("[hidden]"),
  );
  await assert.rejects(worker.shoot(), CREDENTIAL_SHOWN);
  await worker.act({ action: "eval", expression: CLEAR_FIELDS });
  assert.ok((await worker.shoot()).length > 0);
  assert.equal(vault.invocations().length, 3);
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

const account = (who: string, host: string): string =>
  lab.site.url(`/account?as=${encodeURIComponent(who)}`, host);

test("a fresh tab of another card never shows a username that a login put in the shared browser", async () => {
  await start([GOOD, OTHER, ALT]);
  const first = await signedIn();
  await lab.main.call("browser.release", { card: first.card.id });
  const seen: string[] = [];

  for (const [who, host] of [
    [USERNAME, "login.example.test"],
    [OTHER_USER, "login.nothing.test"],
  ] as const) {
    const visitor = await lab.worker("Look at the account");
    const opened = await visitor.act({ action: "open", url: account(who, host) });
    assert.match(
      opened,
      /^Opened "c-\d+ .*Account of \[hidden\]" at http:\/\/.*\?as=\[hidden\] in your tab /,
    );
    const title = await visitor.act({ action: "eval", expression: "document.title" });
    assert.match(title, /Account of \[hidden\]"$/);
    assert.equal(await visitor.act({ action: "read", selector: "#who" }), "[hidden]");
    await assert.rejects(visitor.shoot(), CREDENTIAL_SHOWN);
    await visitor.act({ action: "eval", expression: retext("who", "someone") });
    assert.ok((await visitor.shoot()).length > 0);
    seen.push(opened, title);
  }
  assertNoSecretAnywhere(seen);
});

test("an entry added to the vault after the hidden values were loaded is hidden when its site is first opened", async () => {
  await start([GOOD]);
  const worker = await signedIn();
  vault.publish([GOOD, OTHER]);

  const opened = await worker.act({
    action: "open",
    url: account(OTHER_USER, "login.nothing.test"),
  });

  assert.match(opened, /Account of \[hidden\]" at http:\/\/.*\?as=\[hidden\] in your tab /);
  assertNoSecretAnywhere([opened]);
});

test("the HTML of a page does not give a value back either", async () => {
  await start();
  const worker = await signedIn("/echo");
  const seen = [
    await worker.act({ action: "read", selector: "#p-echo", html: true }),
    await worker.act({ action: "eval", expression: "document.body.outerHTML" }),
  ];
  assert.equal(seen[0], '<p id="p-echo">[hidden]</p>');
  assert.match(
    String(JSON.parse(seen[1] ?? "")),
    /<p id="u-echo">\[hidden\]<\/p><p id="p-echo">\[hidden\]<\/p>/,
  );
  assertNoSecretAnywhere(seen);
});

test("a value that the page writes into an attribute does not come back through its HTML", async () => {
  await start([WITH_TRICKY]);
  const worker = await signedIn("/echo");
  const html = await worker.act({
    action: "eval",
    expression: `(() => { const el = document.getElementById("p-echo"); el.setAttribute("title", ${FIELD("p")}.value); return [el.outerHTML, el.innerHTML]; })()`,
  });
  assert.deepEqual(JSON.parse(html), ['<p id="p-echo" title="[hidden]">[hidden]</p>', "[hidden]"]);
  assertNoSecretAnywhere([html]);
});

test("a one-time code that login generates is hidden like the other values", async () => {
  await start([GOOD], { totp: true });
  const worker = await lab.worker("Sign in to the portal");
  await worker.act({ action: "open", url: lab.site.url("/login", "login.example.test") });
  assert.match(
    await worker.act({ action: "login" }),
    /^filled: Filled the username and password and one-time code\./,
  );
  const seen = [
    await worker.act({ action: "eval", expression: `${FIELD("c")}.value` }),
    await worker.act({ action: "read", selector: "form", html: true }),
  ];
  assert.equal(seen[0], hidden("[hidden]"));
  assert.doesNotMatch(seen.join("\n"), /\d{6}/);

  await worker.act({ action: "click", selector: "#submit" });
  await until(() => (lab.site.posted.length === 1 ? true : undefined), "the sign-in to be posted");
  assert.match(lab.site.posted[0]?.code ?? "", /^\d{6}$/);
  assertNoSecretAnywhere(seen);
});

const AGAIN =
  /^Error: this tab was already open when cardd restarted, and it may show a one-time code that cardd can no longer hide/;

test("with one-time codes on, a tab that outlived a cardd restart is refused until it is opened again", async () => {
  await start([GOOD], { totp: true });
  const before = await lab.worker("Sign in to the portal");
  await before.act({ action: "open", url: lab.site.url("/login", "login.example.test") });
  await before.act({ action: "login" });
  assert.equal(
    await before.act({ action: "eval", expression: `${FIELD("c")}.value` }),
    hidden("[hidden]"),
  );
  await lab.cardd.restart();
  const worker = await lab.reconnect(before);

  await assert.rejects(worker.act({ action: "read" }), AGAIN);
  await assert.rejects(worker.act({ action: "eval", expression: `${FIELD("c")}.value` }), AGAIN);
  await assert.rejects(worker.shoot(), AGAIN);

  assert.match(
    await worker.act({ action: "open", url: lab.site.url("/login", "login.example.test") }),
    /^Opened /,
  );
  const seen = [
    await worker.act({ action: "eval", expression: `${FIELD("c")}.value` }),
    await worker.act({ action: "read", selector: "form" }),
  ];
  assert.equal(seen[0], '""');
  assert.doesNotMatch(seen[1] ?? "", /\d{6}/);
  assert.ok((await worker.shoot()).length > 0);
  assertNoSecretAnywhere(seen);
});

const KEPT =
  /^Error: this tab was already open when cardd restarted, and the address you gave did not replace its page/;

test("with one-time codes on, an open that only changes the fragment does not clear the refusal", async () => {
  await start([GOOD], { totp: true });
  const login = lab.site.url("/login", "login.example.test");
  const before = await lab.worker("Sign in to the portal");
  await before.act({ action: "open", url: login });
  await before.act({ action: "login" });
  await lab.cardd.restart();
  const worker = await lab.reconnect(before);

  await assert.rejects(worker.act({ action: "open", url: `${login}#again` }), KEPT);
  await assert.rejects(worker.act({ action: "read" }), AGAIN);
  await assert.rejects(worker.act({ action: "eval", expression: `${FIELD("c")}.value` }), AGAIN);
  await assert.rejects(worker.shoot(), AGAIN);

  assert.match(await worker.act({ action: "open", url: `${login}?fresh=1` }), /^Opened /);
  const seen = [
    await worker.act({ action: "eval", expression: `${FIELD("c")}.value` }),
    await worker.act({ action: "read", selector: "form" }),
  ];
  assert.equal(seen[0], '""');
  assert.doesNotMatch(seen[1] ?? "", /\d{6}/);
  assert.ok((await worker.shoot()).length > 0);
  assertNoSecretAnywhere(seen);
});
