import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { BrowserLab, type RawWorker } from "../support/browser-lab.ts";
import { FakeVault } from "../support/fake-vault.ts";
import {
  CREDENTIAL_SHOWN,
  GOOD,
  assertNoSecretAnywhere as scan,
  clearedByHand,
  retext,
  signedIn as signIn,
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
  vault.publish([GOOD]);
  lab = await BrowserLab.start({ vault, isolated });
}

const signedIn = (path: string): Promise<RawWorker> => signIn(lab, path);
const cleared = (worker: RawWorker): Promise<void> => clearedByHand(lab, worker);

const PNG = "iVBORw0KGgo";
const HTML = "document.documentElement.outerHTML";

async function refusedThenClean(worker: RawWorker, clean: string): Promise<void> {
  await assert.rejects(worker.shoot(), CREDENTIAL_SHOWN);
  await worker.act({ action: "eval", expression: clean });
  assert.ok((await worker.shoot()).startsWith(PNG));
}

test("a screenshot of the filled login form is refused, also after a show-password toggle", async () => {
  await start();
  const worker = await signedIn("/login");
  await assert.rejects(worker.shoot(), CREDENTIAL_SHOWN);

  await worker.act({ action: "click", selector: "#reveal" });
  await assert.rejects(worker.shoot(), CREDENTIAL_SHOWN);

  await cleared(worker);
  assert.ok((await worker.shoot()).startsWith(PNG));
  scan(lab, vault);
});

test("a screenshot is refused when the page echoes the username in a paragraph", async () => {
  await start();
  const worker = await signedIn("/echo");
  await cleared(worker);
  await refusedThenClean(
    worker,
    `${retext("u-echo", "someone")}; ${retext("p-echo", "something")}`,
  );
  scan(lab, vault);
});

test("a screenshot is refused when a failed login left the username in the page", async () => {
  await start();
  const worker = await lab.worker("Sign in to the portal");
  await worker.act({ action: "open", url: lab.site.url("/fragile", "login.example.test") });
  await assert.rejects(worker.act({ action: "login" }), /^Error: login failed: /);
  await cleared(worker);
  await refusedThenClean(worker, retext("u-echo", "someone"));
  scan(lab, vault);
});

for (const [place, what] of [
  ["split", "splits it across inline elements"],
  ["hidden", "splits it around an element that is not shown"],
  ["cvhidden", "splits it around a hidden box and a shadow host with a direct text child"],
  ["flattened", "splits it around a box that a transform flattens and a shadow host"],
  ["hostsplit", "splits it between its text and an open shadow host"],
  ["closedsplit", "splits it between its text and a closed shadow host"],
  ["escaped", "writes it out as HTML character references"],
  ["same", "shows it in an iframe"],
  ["cross", "shows it in an iframe of another site"],
  ["open", "shows it in an open shadow root"],
  ["closed", "shows it in a closed shadow root"],
  ["attr", "draws it with a pseudo-element from an attribute"],
  ["after", "joins its text to a generated ::after content"],
  ["option", "shows it as the label of a select option"],
  ["attribute", "holds it in an attribute and shows nothing"],
] as const)
  test(`a screenshot is refused when the page ${what}`, async () => {
    await start(place === "cross");
    const worker = await signedIn(`/places?at=${place}`);
    await cleared(worker);
    await worker.act({ action: "eval", expression: "window.ready" });
    await assert.rejects(worker.shoot(), CREDENTIAL_SHOWN);

    await worker.act({ action: "eval", expression: `window.put("someone")` });
    assert.ok((await worker.shoot()).startsWith(PNG));
    scan(lab, vault);
  });

test("a screenshot of a clean signed-in page is returned and changes nothing on the page", async () => {
  await start();
  const worker = await signedIn("/login");
  await cleared(worker);
  await worker.act({ action: "click", selector: "#submit" });
  await worker.act({
    action: "eval",
    expression: `new Promise((resolve) => {
      const check = () => (document.getElementById("msg").textContent === "" ? setTimeout(check, 20) : resolve("ready"));
      check();
    })`,
  });
  const before = await worker.act({ action: "eval", expression: HTML });

  const image = await worker.shoot();
  assert.ok(image.startsWith(PNG));
  assert.equal(await worker.act({ action: "eval", expression: HTML }), before);
  scan(lab, vault);
});

test("a full-page screenshot refuses a value below the fold and then covers the whole page", async () => {
  await start();
  const worker = await signedIn("/tall");
  await cleared(worker);
  await assert.rejects(worker.shoot(true), CREDENTIAL_SHOWN);

  await worker.act({ action: "eval", expression: retext("who", "someone") });
  const image = await worker.shoot(true);
  assert.ok(Buffer.from(image, "base64").readUInt32BE(20) > 1400);
  scan(lab, vault);
});
