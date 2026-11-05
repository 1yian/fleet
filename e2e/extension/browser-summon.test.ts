import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { BrowserHerdr, until, type Worker } from "../support/browser-herdr.ts";
import { FakeVault } from "../support/fake-vault.ts";
import { optionalString, parseRecord } from "../support/json.ts";
import { GOOD } from "../support/login-fixtures.ts";

let fleet: BrowserHerdr;
let vault: FakeVault | undefined;

afterEach(async (t) => {
  await fleet.stop(t);
  vault?.dispose();
  vault = undefined;
});

const BROWSER = "Browser";

const errorOf = (text: string): string =>
  optionalString(parseRecord(text.split("\n")[0] ?? ""), "error") ?? "";

const heardBy = async (call: number): Promise<string> =>
  (await fleet.h.waitForCall(call, "mate")).map((turn) => turn.text).join("\n");

async function signedIn(worker: Worker): Promise<void> {
  const portal = fleet.site.url("/portal", "login.example.test");
  assert.equal((await fleet.axi(worker, `open '${portal}'`)).code, 0);
  assert.equal((await fleet.axi(worker, "login")).code, 0);
}

test("--captain files the summon when the action is refused, for a screenshot and for an eval, and the error says so", async () => {
  vault = new FakeVault([GOOD]);
  fleet = await BrowserHerdr.start({ browser: true, vault });
  const [shooter, evaluator] = await fleet.workers(["Pay the invoice", "Accept the terms"]);
  assert.ok(shooter !== undefined && evaluator !== undefined);
  fleet.h.onModel(() => ({ text: "told the captain" }), "mate");
  await fleet.startMain();
  const main = await fleet.mainWorkspace();
  await signedIn(shooter);
  await signedIn(evaluator);

  const refused = await fleet.axi(shooter, "screenshot --captain 'finish the second factor'");
  assert.equal(refused.code, 1, refused.text);
  assert.match(
    errorOf(refused.text),
    /this page shows a stored credential.*\. The captain was asked to open the tab: finish the second factor\.$/,
  );
  await until("the Browser tab in main's workspace", async () =>
    (await fleet.tabLabels(main)).includes(BROWSER) ? true : undefined,
  );
  assert.match(
    await heardBy(0),
    new RegExp(
      `c-${String(shooter.card.id)} pay-the-invoice needs the captain in its browser tab: finish the second factor`,
    ),
  );

  const unevaluated = await fleet.axi(
    evaluator,
    "eval 'document.title' --captain 'accept the terms'",
  );
  assert.equal(unevaluated.code, 1, unevaluated.text);
  assert.match(
    errorOf(unevaluated.text),
    /nothing was evaluated: a stored credential is in this page's form; click Sign in first, or read the page as text\. The captain was asked to open the tab: accept the terms\.$/,
  );
  assert.match(
    await heardBy(1),
    new RegExp(
      `c-${String(evaluator.card.id)} accept-the-terms needs the captain in its browser tab: accept the terms`,
    ),
  );
  assert.equal((await fleet.tabLabels(main)).filter((label) => label === BROWSER).length, 1);
  assert.equal((await fleet.tabsSeenBy(await fleet.viewerOf(main))).length, 2);
});

test("--captain from a card with no tab summons nobody", async () => {
  fleet = await BrowserHerdr.start({ browser: true });
  const [worker] = await fleet.workers(["Look at the site"]);
  assert.ok(worker !== undefined);
  fleet.h.onModel(() => ({ text: "told the captain" }), "mate");
  await fleet.startMain();

  const refused = await fleet.axi(worker, "read --captain 'no tab yet'");
  assert.equal(refused.code, 1, refused.text);
  assert.match(errorOf(refused.text), /you have no tab yet/);
  assert.doesNotMatch(errorOf(refused.text), /captain was asked/);

  const opened = await fleet.axi(
    worker,
    `open ${fleet.site.url("/a")} --captain 'the bank asks for a passkey'`,
  );
  assert.equal(opened.code, 0, opened.text);
  const heard = await heardBy(0);
  assert.match(heard, /the bank asks for a passkey/);
  assert.doesNotMatch(heard, /no tab yet/);
});
