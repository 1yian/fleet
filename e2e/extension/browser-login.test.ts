import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { afterEach, beforeEach, test } from "node:test";
import { BrowserLab, browse, results } from "../support/browser-lab.ts";
import { FakeVault } from "../support/fake-vault.ts";
import { filesHolding } from "../support/leaks.ts";
import type { Turn } from "../support/harness.ts";

const USERNAME = "captain.login@example.test";
const PASSWORD = "Tr0ub4dor&3-correct-horse-9f2e1b7a";
const SEED = "JBSWY3DPEHPK3PXP";
const BROKEN = "hunter2-not-json-a8b7c6d5";
const SECRETS = [PASSWORD, USERNAME, SEED, BROKEN];

const GOOD = {
  key: "example.test",
  value: JSON.stringify({ username: USERNAME, password: PASSWORD, totp: SEED }),
};

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
  lab = await BrowserLab.start(vault);
}

const heard = (turns: readonly Turn[][]): string => JSON.stringify(turns);

function assertNoSecretAnywhere(...crews: { h: { calls: Turn[][] } }[]): void {
  const dir = process.env["TMPDIR"] ?? "/tmp";
  const canary = `${dir}/canary-for-the-scan.txt`;
  writeFileSync(canary, `the scan must see ${PASSWORD}`);
  assert.deepEqual(filesHolding(SECRETS, dir, skipChromeProfile), [canary]);
  writeFileSync(canary, "");
  assert.deepEqual(filesHolding(SECRETS, dir, skipChromeProfile), []);
  for (const crew of crews)
    for (const secret of SECRETS) assert.equal(heard(crew.h.calls).includes(secret), false);
  for (const secret of SECRETS) {
    assert.equal(lab.cardd.output.includes(secret), false);
    assert.equal(lab.cardd.errors.includes(secret), false);
    assert.equal(vault.invocations().join("\n").includes(secret), false);
  }
}

const skipChromeProfile = (name: string): boolean => name.startsWith("playwright");

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
  assert.equal(vault.invocations().length, 1);
  assert.match(vault.invocations()[0] ?? "", /^secret list [0-9a-f-]{36} --output json$/);
  assertNoSecretAnywhere(worker);
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
  assertNoSecretAnywhere(worker);
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
  assertNoSecretAnywhere(worker);
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
  assert.deepEqual(vault.invocations(), []);
  assert.deepEqual(lab.site.posted, []);
});

test("a vault that refuses the machine account is reported as failed with its reason", async () => {
  await start();
  writeFileSync(vault.tokenFile, "0.a-token-the-vault-does-not-know\n");
  const worker = await lab.crew("Sign in to the portal");
  browse(worker.h, { action: "open", url: lab.site.url("/login", "login.example.test") });
  browse(worker.h, { action: "login" });
  worker.h.onModel(() => ({ tool: "report", args: { status: "blocked", text: "no vault" } }));
  const seen = results(await worker.h.waitForCall(2));
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
  assertNoSecretAnywhere(worker);
});
