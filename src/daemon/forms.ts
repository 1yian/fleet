import type { PageSession } from "./page-session.js";

export type FieldKind = "username" | "password" | "newpassword" | "otp";

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
