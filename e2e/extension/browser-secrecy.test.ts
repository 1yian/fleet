import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { BrowserLab, type RawWorker } from "../support/browser-lab.ts";
import { FakeVault } from "../support/fake-vault.ts";
import {
  ALL_VALUES,
  FIELD,
  GOOD,
  OTHER,
  OTHER_USER,
  PASSWORD,
  REFUSAL,
  RETYPE,
  USERNAME,
  WITH_TRICKY,
  assertNoSecretAnywhere as scan,
  bullets,
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

async function start(entries = [GOOD]): Promise<void> {
  vault.publish(entries);
  lab = await BrowserLab.start({ vault });
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
  assert.equal(vault.invocations().length, 2);
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

test("a screenshot shows neither the fields nor the text a page echoes from them", async () => {
  await start();
  const worker = await signedIn("/echo");
  const covered = await worker.shoot();
  assert.equal(await worker.act({ action: "read", selector: "#u-echo" }), "[hidden]");
  assert.equal(await worker.act({ action: "read", selector: "#p-echo" }), "[hidden]");

  await worker.act({ action: "eval", expression: RETYPE });
  await worker.act({
    action: "eval",
    expression: `document.getElementById("u-echo").textContent = "${bullets(USERNAME.length)}"; document.getElementById("p-echo").textContent = "${bullets(PASSWORD.length)}"`,
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
  assert.equal(await worker.act({ action: "read", selector: "#u-echo" }), "[hidden]");

  await worker.act({
    action: "eval",
    expression: `${FIELD("u")}.value = "x".repeat(${String(USERNAME.length)}); document.getElementById("u-echo").textContent = "${bullets(USERNAME.length)}"`,
  });
  assert.equal(await worker.shoot(), covered);
  assertNoSecretAnywhere();
});
