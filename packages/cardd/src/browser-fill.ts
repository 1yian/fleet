import { parseCdp } from "@fleet/protocol";
import Type from "typebox";
import { call, evaluate, type Page } from "./browser-page.ts";
import { totpCode } from "./browser-totp.ts";

export interface Credentials {
  readonly username: string;
  readonly password: string;
  readonly totp?: string | undefined;
}

const LOCATE = `(() => {
  const shown = (el) => {
    const box = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return box.width > 0 && box.height > 0 && style.visibility !== "hidden" && style.display !== "none" && !el.disabled && !el.readOnly;
  };
  const inputs = [...document.querySelectorAll("input")].filter(shown);
  const password = inputs.find((el) => el.type === "password") ?? null;
  const scope = password !== null && password.form !== null ? [...password.form.querySelectorAll("input")].filter(shown) : inputs;
  const typed = (el) => ["text", "email", "tel", ""].includes(el.type);
  const before = password === null ? scope : scope.slice(0, scope.indexOf(password));
  const user = before.filter(typed).at(-1) ?? null;
  const code = inputs.find((el) => el.autocomplete === "one-time-code" || /otp|totp|2fa|verification|mfa/i.test(el.name + " " + el.id)) ?? null;
  return { user, password, code };
})()`;

const PropertiesSchema = Type.Object({
  result: Type.Array(
    Type.Object({
      name: Type.String(),
      value: Type.Optional(Type.Object({ objectId: Type.Optional(Type.String()) })),
    }),
  ),
});
const HandleSchema = Type.Object({ result: Type.Object({ objectId: Type.String() }) });
const LengthSchema = Type.Object({ result: Type.Object({ value: Type.Number() }) });

type Slot = "user" | "password" | "code";

async function locate(page: Page): Promise<Map<Slot, string>> {
  const handle = parseCdp(
    HandleSchema,
    await call(page, "Runtime.evaluate", { expression: LOCATE }),
    "the page's fields",
  );
  const listed = parseCdp(
    PropertiesSchema,
    await call(page, "Runtime.getProperties", {
      objectId: handle.result.objectId,
      ownProperties: true,
    }),
    "the page's fields",
  );
  const found = new Map<Slot, string>();
  for (const { name, value } of listed.result) {
    const id = value?.objectId;
    if (id !== undefined && (name === "user" || name === "password" || name === "code"))
      found.set(name, id);
  }
  return found;
}

async function enter(page: Page, objectId: string, text: string): Promise<boolean> {
  await call(page, "Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: "function () { this.focus(); this.select(); }",
  });
  await call(page, "Input.insertText", { text });
  const length = parseCdp(
    LengthSchema,
    await call(page, "Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: "function () { return this.value.length; }",
      returnByValue: true,
    }),
    "a field's length",
  );
  return length.result.value === text.length;
}

export async function pageHost(page: Page): Promise<string> {
  const href = await evaluate(page, "location.href");
  try {
    return new URL(String(href)).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function codeFor(creds: Credentials, allowed: boolean): string | undefined {
  return allowed && creds.totp !== undefined ? totpCode(creds.totp, Date.now()) : undefined;
}

export async function fillLogin(
  page: Page,
  creds: Credentials,
  codesAllowed: boolean,
): Promise<string> {
  const fields = await locate(page);
  const wanted: [Slot, string, string | undefined][] = [
    ["user", "username", creds.username],
    ["password", "password", creds.password],
    ["code", "one-time code", codeFor(creds, codesAllowed)],
  ];
  const filled: string[] = [];
  const failed: string[] = [];
  for (const [slot, name, text] of wanted) {
    const objectId = fields.get(slot);
    if (objectId === undefined || text === undefined) continue;
    if (await enter(page, objectId, text)) filled.push(name);
    else failed.push(name);
  }
  if (failed.length > 0)
    throw new Error(`the page did not keep the ${failed.join(" and ")} that was typed into it`);
  if (filled.length === 0)
    throw new Error(
      "no username or password field is visible on this page: open the login page, then try again",
    );
  const notes: string[] = [];
  if (!fields.has("password"))
    notes.push(
      "No password field is visible yet: submit the form, then call login again for the next step.",
    );
  if (creds.totp !== undefined && !codesAllowed)
    notes.push("The entry has a one-time-code seed, which the fleet does not fill yet.");
  return [`Filled the ${filled.join(" and ")}.`, ...notes].join(" ");
}
