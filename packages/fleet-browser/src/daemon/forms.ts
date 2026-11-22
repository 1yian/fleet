import type { DirectLogin } from "../shared/direct-login.js";
import type { DirectPlan, PageSession } from "./page-session.js";

type FieldKind = "username" | "password" | "newpassword" | "otp";

export interface FieldInfo {
  i: number;
  kind: FieldKind;
  visible: boolean;
  filled: boolean;
}

const DETECT = `(() => {
  const els = [];
  const walk = (root) => {
    for (const el of root.querySelectorAll('input, textarea')) els.push(el);
    for (const host of root.querySelectorAll('*')) if (host.shadowRoot) walk(host.shadowRoot);
  };
  walk(document);
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
  };
  const label = (el) => (el.labels && el.labels[0] ? el.labels[0].innerText : '');
  const hints = (el) => [el.name, el.id, el.placeholder, el.getAttribute('aria-label'), el.autocomplete, label(el)].filter(Boolean).join(' ').toLowerCase();
  const classify = (el) => {
    const type = (el.type || 'text').toLowerCase();
    const h = hints(el);
    if (type === 'password') return /new|confirm|repeat|retype/.test(h) || el.autocomplete === 'new-password' ? 'newpassword' : 'password';
    if (['hidden', 'submit', 'button', 'checkbox', 'radio', 'file', 'image', 'reset', 'range', 'color', 'date'].includes(type)) return null;
    if (el.autocomplete === 'one-time-code' || /otp|totp|one.?time|verification code|authenticator|2fa|security code|passcode|\\bcode\\b/.test(h)) return 'otp';
    if (type === 'email' || el.autocomplete === 'username' || el.autocomplete === 'email' || /user|login|email|e-mail|phone|identifier|account|mobile/.test(h)) return 'username';
    return null;
  };
  Object.defineProperty(globalThis, '__fbFields', { value: els, configurable: true, writable: true, enumerable: false });
  const out = [];
  els.forEach((el, i) => {
    const kind = classify(el);
    if (kind) out.push({ i, kind, visible: visible(el), filled: (el.value || '').length > 0 });
  });
  return out;
})()`;

const DIRECT_LOGIN = `function (mode, origin, username, password, expected) {
  if (location.origin !== origin || location.protocol !== 'https:') return 'off-origin';
  const fields = ${DETECT};
  const elements = globalThis.__fbFields;
  delete globalThis.__fbFields;
  const eligible = (kind, form) => fields.filter(f => f.visible && f.kind === kind)
    .map(f => elements[f.i])
    .filter(el => el.name && el.form && !el.matches(':disabled') && !el.readOnly && (!form || el.form === form));
  const passwords = eligible('password');
  if (passwords.length !== 1) return 'no-form';
  const passwordField = passwords[0];
  const form = passwordField.form;
  let userField = null;
  if (username !== null) {
    const users = eligible('username', form);
    if (users.length !== 1) return 'no-form';
    userField = users[0];
  }
  const own = (name) => Object.getOwnPropertyDescriptor(HTMLFormElement.prototype, name).get.call(form);
  const target = own('target') || document.querySelector('base[target]')?.target || '_self';
  let destination;
  try {
    destination = new URL(own('action'));
  } catch {
    return 'no-form';
  }
  if (own('method') !== 'post' || own('enctype') !== 'application/x-www-form-urlencoded'
    || destination.protocol !== 'https:' || destination.origin !== origin
    || target.toLowerCase() !== '_self') return 'no-form';
  const plan = { action: destination.href, userName: userField ? userField.name : null, passName: passwordField.name };
  if (mode === 'plan') return plan;
  if (JSON.stringify(plan) !== JSON.stringify(expected)) return 'no-form';
  const set = (el, value) => {
    const prototype = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(el, value);
  };
  if (userField) set(userField, username);
  set(passwordField, password);
  HTMLFormElement.prototype.submit.call(form);
  return 'submitted';
}`;

type DirectResult = DirectPlan | "submitted" | "off-origin" | "no-form" | "stuck";

async function directLoginCall(
  page: PageSession,
  delivery: DirectLogin,
  mode: "plan" | "submit",
  plan: DirectPlan | null,
): Promise<DirectResult> {
  const { frameTree } = await page.send<{ frameTree: { frame: { id: string } } }>("Page.getFrameTree");
  const { executionContextId } = await page.send<{ executionContextId: number }>("Page.createIsolatedWorld", {
    frameId: frameTree.frame.id,
    worldName: "fleet-browser-direct-login",
  });
  const {
    result: { objectId },
  } = await page.send<{ result: { objectId?: string } }>("Runtime.evaluate", {
    expression: "globalThis",
    contextId: executionContextId,
  });
  if (!objectId) return "stuck";
  const response = await page.send<{ result: { value?: DirectResult }; exceptionDetails?: unknown }>(
    "Runtime.callFunctionOn",
    {
      objectId,
      functionDeclaration: DIRECT_LOGIN,
      arguments: [
        { value: mode },
        { value: delivery.origin },
        { value: delivery.username ?? null },
        { value: mode === "submit" ? delivery.password : null },
        { value: plan },
      ],
      returnByValue: true,
      silent: true,
    },
  );
  const outcome = response.result.value;
  if (typeof outcome === "object" && outcome !== null) return outcome;
  if (outcome === "submitted" || outcome === "off-origin" || outcome === "no-form") return outcome;
  return "stuck";
}

export async function planDirectLogin(
  page: PageSession,
  delivery: DirectLogin,
): Promise<DirectPlan | "off-origin" | "no-form" | "stuck"> {
  const result = await directLoginCall(page, delivery, "plan", null);
  return result === "submitted" ? "stuck" : result;
}

export async function submitDirectLogin(
  page: PageSession,
  delivery: DirectLogin,
  plan: DirectPlan,
): Promise<"submitted" | "off-origin" | "no-form" | "stuck"> {
  const result = await directLoginCall(page, delivery, "submit", plan);
  return typeof result === "object" ? "stuck" : result;
}

export function detectFields(page: PageSession): Promise<FieldInfo[]> {
  return page.evaluate<FieldInfo[]>(DETECT);
}

export async function forgetFields(page: PageSession): Promise<void> {
  await page.evaluate("delete globalThis.__fbFields").catch(() => undefined);
}

async function focusField(page: PageSession, index: number): Promise<void> {
  const target = await page.send<{ result: { objectId?: string } }>("Runtime.evaluate", {
    expression: `globalThis.__fbFields[${index}]`,
  });
  if (!target.result.objectId) throw new Error("the field disappeared before it could be filled");
  await page.send("DOM.focus", { objectId: target.result.objectId });
}

async function selectAll(page: PageSession): Promise<void> {
  await page.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "a",
    code: "KeyA",
    windowsVirtualKeyCode: 65,
    modifiers: 2,
    commands: ["selectAll"],
  });
  await page.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "a",
    code: "KeyA",
    windowsVirtualKeyCode: 65,
    modifiers: 2,
  });
}

export async function fillField(page: PageSession, index: number, value: string): Promise<void> {
  await focusField(page, index);
  await selectAll(page);
  await page.send("Input.insertText", { text: value });
}

export async function clearField(page: PageSession, index: number): Promise<void> {
  await focusField(page, index);
  await selectAll(page);
  await page.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Backspace",
    code: "Backspace",
    windowsVirtualKeyCode: 8,
  });
  await page.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Backspace",
    code: "Backspace",
    windowsVirtualKeyCode: 8,
  });
}

export async function pressEnter(page: PageSession): Promise<void> {
  await page.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    text: "\r",
  });
  await page.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
  });
}

export async function focusedFieldKind(page: PageSession): Promise<number | null> {
  return page.evaluate<number | null>(
    "(() => { const a = document.activeElement; const i = globalThis.__fbFields ? globalThis.__fbFields.indexOf(a) : -1; return i >= 0 ? i : null; })()",
  );
}

const PROBLEM_WORDS =
  /incorrect|wrong password|invalid|couldn.t find|not recognized|try again|too many|locked|captcha|verify it.s you|unusual|suspicious|blocked|not secure|expired/gi;

export async function problemHints(page: PageSession): Promise<string[]> {
  const text = await page
    .evaluate<string>("document.body ? document.body.innerText.slice(0, 3000) : ''")
    .catch(() => "");
  return [...new Set((text.match(PROBLEM_WORDS) ?? []).map((word) => word.toLowerCase()))].slice(0, 5);
}

export async function pageSummary(page: PageSession): Promise<{ url: string; title: string }> {
  return page
    .evaluate<{ url: string; title: string }>("({ url: location.href, title: document.title })")
    .catch(() => ({ url: "", title: "" }));
}
