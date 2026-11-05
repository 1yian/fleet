import { keyPresses, parseCdp, type BrowserArgs, type Cdp } from "@fleet/protocol";
import Type from "typebox";
import { scrubbedValue } from "./browser-hidden.ts";

export interface Page {
  readonly cdp: Cdp;
  readonly session: string;
}

export const call = (page: Page, method: string, params: unknown = {}): Promise<unknown> =>
  page.cdp.send(method, params, { sessionId: page.session });

const TEXT_LIMIT = 30_000;
const LOAD_MS = 30_000;

const EvalSchema = Type.Object({
  result: Type.Object({
    type: Type.String(),
    value: Type.Optional(Type.Unknown()),
    objectId: Type.Optional(Type.String()),
    description: Type.Optional(Type.String()),
  }),
  exceptionDetails: Type.Optional(
    Type.Object({
      text: Type.String(),
      exception: Type.Optional(Type.Object({ description: Type.Optional(Type.String()) })),
    }),
  ),
});
const NavigateSchema = Type.Object({
  errorText: Type.Optional(Type.String()),
  loaderId: Type.Optional(Type.String()),
});
const FrameTreeSchema = Type.Object({
  frameTree: Type.Object({ frame: Type.Object({ loaderId: Type.String(), url: Type.String() }) }),
});
const SummarySchema = Type.Object({ title: Type.String(), url: Type.String() });
const PointSchema = Type.Object({ x: Type.Number(), y: Type.Number() });

async function evaluate(page: Page, expression: string): Promise<unknown> {
  const done = parseCdp(
    EvalSchema,
    await call(page, "Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    }),
    "an evaluation",
  );
  if (done.exceptionDetails !== undefined)
    throw new Error(
      `the page threw: ${done.exceptionDetails.exception?.description ?? done.exceptionDetails.text}`,
    );
  return done.result.value;
}

export function checkedUrl(url: string | undefined): string {
  if (url === undefined || url === "") throw new Error("open needs a url");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${url} is not a full http or https address`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    throw new Error(`only http and https pages can be opened, not ${parsed.protocol}`);
  return parsed.toString();
}

function loaded(page: Page): { done: Promise<boolean>; stop: () => void } {
  let stop = (): void => undefined;
  const done = new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      stop();
      resolve(false);
    }, LOAD_MS);
    const unlisten = page.cdp.listen((event) => {
      if (event.sessionId === page.session && event.method === "Page.loadEventFired") {
        stop();
        resolve(true);
      }
    });
    stop = () => {
      clearTimeout(timer);
      unlisten();
    };
  });
  return { done, stop };
}

export interface Doc {
  readonly loader: string;
  readonly host: string;
}

export async function documentOf(page: Page): Promise<Doc> {
  const { frameTree } = parseCdp(
    FrameTreeSchema,
    await call(page, "Page.getFrameTree"),
    "the page's frame",
  );
  try {
    return {
      loader: frameTree.frame.loaderId,
      host: new URL(frameTree.frame.url).hostname.toLowerCase(),
    };
  } catch {
    return { loader: frameTree.frame.loaderId, host: "" };
  }
}

export async function summary(page: Page): Promise<string> {
  const text = await evaluate(
    page,
    "JSON.stringify({ title: document.title, url: location.href })",
  );
  const found = parseCdp(SummarySchema, JSON.parse(String(text)), "the page summary");
  return `"${found.title}" at ${found.url}`;
}

async function send(page: Page, url: string): Promise<boolean> {
  const sent = parseCdp(NavigateSchema, await call(page, "Page.navigate", { url }), "a navigation");
  if (sent.errorText !== undefined) throw new Error(`could not load ${url}: ${sent.errorText}`);
  return sent.loaderId !== undefined;
}

export async function navigate(page: Page, url: string): Promise<string> {
  const wait = loaded(page);
  const replaces = await send(page, url).catch((error: unknown) => {
    wait.stop();
    throw error;
  });
  if (!replaces) wait.stop();
  const finished = !replaces || (await wait.done);
  const state = finished ? "" : " (still loading after 30 s)";
  return `${await summary(page)}${state}`;
}

export const cut = (text: string): string =>
  text.length <= TEXT_LIMIT
    ? text
    : `${text.slice(0, TEXT_LIMIT)}\n[cut: ${String(text.length - TEXT_LIMIT)} more characters. Read a smaller part with a selector]`;

export async function readPage(page: Page, args: BrowserArgs): Promise<string> {
  const html = args.html === true;
  const element =
    args.selector === undefined
      ? html
        ? "document.documentElement"
        : "document.body"
      : `document.querySelector(${JSON.stringify(args.selector)})`;
  const value = await evaluate(
    page,
    `(() => { const el = ${element}; return el === null ? null : ${html ? "el.outerHTML" : "el.innerText"}; })()`,
  );
  if (typeof value !== "string")
    throw new Error(`no element matches ${args.selector ?? "the page"}`);
  return value;
}

export async function runExpression(
  page: Page,
  expression: string | undefined,
  secrets: readonly string[],
): Promise<string> {
  if (expression === undefined) throw new Error("eval needs an expression");
  const value = await evaluate(page, expression);
  return value === undefined ? "undefined" : JSON.stringify(scrubbedValue(value, secrets), null, 2);
}

async function centerOf(page: Page, selector: string): Promise<{ x: number; y: number }> {
  const found = await evaluate(
    page,
    `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (el === null) return null;
      el.scrollIntoView({ block: "center", inline: "center" });
      const box = el.getBoundingClientRect();
      return box.width === 0 || box.height === 0 ? null : { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    })()`,
  );
  if (found === null) throw new Error(`no visible element matches ${selector}`);
  return parseCdp(PointSchema, found, "an element position");
}

export async function clickPage(page: Page, args: BrowserArgs): Promise<string> {
  if (args.selector === undefined && (args.x === undefined || args.y === undefined))
    throw new Error("click needs a selector, or x and y");
  const { x, y } =
    args.selector === undefined
      ? { x: args.x ?? 0, y: args.y ?? 0 }
      : await centerOf(page, args.selector);
  const mouse = { x, y, button: "left", clickCount: 1 };
  await call(page, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await call(page, "Input.dispatchMouseEvent", { type: "mousePressed", ...mouse });
  await call(page, "Input.dispatchMouseEvent", { type: "mouseReleased", ...mouse });
  return `Clicked ${args.selector ?? `${String(x)},${String(y)}`}.`;
}

export async function pressKey(page: Page, key: string | undefined): Promise<string> {
  if (key === undefined) throw new Error("press needs a key");
  for (const event of keyPresses(key)) await call(page, "Input.dispatchKeyEvent", event);
  return `Pressed ${key}.`;
}

async function focusElement(page: Page, selector: string): Promise<void> {
  const found = await evaluate(
    page,
    `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (el === null) return false;
      el.focus();
      if (typeof el.select === "function") el.select();
      return true;
    })()`,
  );
  if (found !== true) throw new Error(`no element matches ${selector}`);
}

export async function typeText(page: Page, args: BrowserArgs): Promise<string> {
  if (args.text === undefined) throw new Error("type needs text");
  if (args.selector !== undefined) await focusElement(page, args.selector);
  await call(page, "Input.insertText", { text: args.text });
  if (args.submit === true) await pressKey(page, "Enter");
  return `Typed ${String(args.text.length)} characters${args.submit === true ? " and pressed Enter" : ""}.`;
}
