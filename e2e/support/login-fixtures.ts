import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { BROWSER_OPS, check } from "@fleet/protocol";
import type { BrowserLab, RawWorker } from "./browser-lab.ts";
import type { FakeVault } from "./fake-vault.ts";
import { filesHolding, formsOf } from "./leaks.ts";

export const USERNAME = "captain.login@example.test";
export const PASSWORD = "Tr0ub4dor&3-correct-horse-9f2e1b7a";
const SEED = "JBSWY3DPEHPK3PXP";
export const BROKEN = "hunter2-not-json-a8b7c6d5";
const TRICKY = `Q"u0te\\Back'slash 9&+%~!z7`;
export const OTHER_USER = "other.captain@nothing.test";
const OTHER_PASSWORD = "Zx9-other-secret-b7e41c0d";
export const ALT_USER = "sailor.signin@example.test";
export const ALT_PASSWORD = "Zq9xk2mwp&7-aligned-moose-4c8d3e1f";
const SECRETS = [
  PASSWORD,
  USERNAME,
  SEED,
  BROKEN,
  TRICKY,
  OTHER_USER,
  OTHER_PASSWORD,
  ALT_USER,
  ALT_PASSWORD,
];

export const GOOD = {
  key: "example.test",
  value: JSON.stringify({ username: USERNAME, password: PASSWORD, totp: SEED }),
};
export const OTHER = {
  key: "nothing.test",
  value: JSON.stringify({ username: OTHER_USER, password: OTHER_PASSWORD }),
};
export const ALT = {
  key: "alt.test",
  value: JSON.stringify({ username: ALT_USER, password: ALT_PASSWORD }),
};
export const WITH_TRICKY = {
  key: "example.test",
  value: JSON.stringify({ username: USERNAME, password: TRICKY }),
};

export const REFUSAL =
  /^Error: the Logins project could not be read to learn which values to hide, so nothing was done/;
export const FIELD = (name: string): string => `document.querySelector("input[name=${name}]")`;
export const ALL_VALUES = "[...document.querySelectorAll('input')].map((el) => el.value)";
export const RETYPE = `for (const [name, length] of [["u", ${String(USERNAME.length)}], ["p", ${String(PASSWORD.length)}]]) document.querySelector("input[name=" + name + "]").value = "x".repeat(length)`;
export const retext = (id: string, text: string): string =>
  `document.getElementById("${id}").textContent = "${text}"`;
export const hidden = (text: string): string => JSON.stringify(text);

const WAIT_MS = 15_000;

export async function until<T>(
  read: () => T | undefined | Promise<T | undefined>,
  what: string,
): Promise<T> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

export async function tabOf(lab: BrowserLab, worker: RawWorker): Promise<string> {
  const view = check(BROWSER_OPS["browser.view"].result, await lab.main.call("browser.view", {}));
  const target = view.tabs.find((tab) => tab.card === worker.card.id)?.target;
  if (target === undefined) throw new Error("the card has no tab");
  return target;
}

export async function signedIn(lab: BrowserLab, path = "/login"): Promise<RawWorker> {
  const worker = await lab.worker("Sign in to the portal");
  await worker.act({ action: "open", url: lab.site.url(path, "login.example.test") });
  assert.match(
    await worker.act({ action: "login" }),
    /^filled: Filled the username and password\./,
  );
  return worker;
}

const skipChromeProfile = (name: string): boolean => name.startsWith("playwright");

export function assertNoSecretAnywhere(
  lab: BrowserLab,
  vault: FakeVault,
  spoken: readonly string[] = [],
): void {
  const dir = process.env["TMPDIR"] ?? "/tmp";
  const canary = `${dir}/canary-for-the-scan.txt`;
  writeFileSync(canary, `the scan must see ${PASSWORD}`);
  assert.deepEqual(filesHolding(SECRETS, dir, skipChromeProfile), [canary]);
  writeFileSync(canary, "");
  assert.deepEqual(filesHolding(SECRETS, dir, skipChromeProfile), []);
  const places = [...spoken, lab.cardd.output, lab.cardd.errors, vault.invocations().join("\n")];
  for (const place of places)
    for (const secret of SECRETS)
      for (const form of formsOf(secret)) assert.equal(place.includes(form), false);
}
