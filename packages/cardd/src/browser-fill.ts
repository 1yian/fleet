import { parseCdp } from "@fleet/protocol";
import Type from "typebox";
import { call, documentOf, type Doc, type Page } from "./browser-page.ts";
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
const TypedSchema = Type.Object({
  result: Type.Object({
    value: Type.Union([Type.Literal("typed"), Type.Literal("kept"), Type.Literal("gone")]),
  }),
});

const TYPE = `function (text) {
  if (!this.isConnected) return "gone";
  this.focus();
  if (document.activeElement !== this) return "gone";
  this.select();
  document.execCommand("insertText", false, text);
  if (this.value === text) return "typed";
  this.value = "";
  return "kept";
}`;

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

function movedTo(now: Doc, doc: Doc): string {
  if (now.host === "") return "another page";
  return now.host === doc.host ? "a new page on the same site" : now.host;
}

async function stillOn(page: Page, doc: Doc): Promise<void> {
  const now = await documentOf(page);
  if (now.loader !== doc.loader)
    throw new Error(
      `the page changed from ${doc.host} to ${movedTo(now, doc)} while the login was being filled, so nothing was typed into the new page. Open the login page again, then call login again`,
    );
}

async function enter(
  page: Page,
  doc: Doc,
  field: { objectId: string; name: string },
  text: string,
): Promise<boolean> {
  let raw: unknown;
  try {
    raw = await call(page, "Runtime.callFunctionOn", {
      objectId: field.objectId,
      functionDeclaration: TYPE,
      arguments: [{ value: text }],
      returnByValue: true,
    });
  } catch (error) {
    await stillOn(page, doc);
    throw error;
  }
  const outcome = parseCdp(TypedSchema, raw, "a field's fill").result.value;
  if (outcome === "gone")
    throw new Error(
      `the ${field.name} field left the page before it could be filled, so it was not typed`,
    );
  return outcome === "typed";
}

function codeFor(
  creds: Credentials,
  allowed: boolean,
  hold: (value: string) => void,
): string | undefined {
  const code = allowed && creds.totp !== undefined ? totpCode(creds.totp, Date.now()) : undefined;
  if (code !== undefined) hold(code);
  return code;
}

export async function fillLogin(
  page: Page,
  doc: Doc,
  creds: Credentials,
  codesAllowed: boolean,
  hold: (value: string) => void,
): Promise<string> {
  const code = codeFor(creds, codesAllowed, hold);
  const fields = await locate(page);
  await stillOn(page, doc);
  const wanted: [Slot, string, string | undefined][] = [
    ["user", "username", creds.username],
    ["password", "password", creds.password],
    ["code", "one-time code", code],
  ];
  const filled: string[] = [];
  const failed: string[] = [];
  for (const [slot, name, text] of wanted) {
    const objectId = fields.get(slot);
    if (objectId === undefined || text === undefined) continue;
    if (await enter(page, doc, { objectId, name }, text)) filled.push(name);
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
