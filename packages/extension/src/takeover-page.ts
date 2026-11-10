import { setTimeout as sleep } from "node:timers/promises";
import { parseCdp, type Cdp } from "@fleet/protocol";
import Type from "typebox";
import Value from "typebox/value";
import { CookieSchema, StorageSchema, type Cookie, type Storage } from "./takeover-session.ts";

const LOAD_MS = 30_000;
const CLOSE_MS = 10_000;
const STUB_PATH = "/.fleet-takeover";
const STUB_PAGE = Buffer.from("<!doctype html><title>Fleet Chrome</title>").toString("base64");

const AttachedSchema = Type.Object({ sessionId: Type.String() });
const CreatedSchema = Type.Object({ targetId: Type.String() });
const TargetsSchema = Type.Object({
  targetInfos: Type.Array(
    Type.Object({
      targetId: Type.String(),
      type: Type.String(),
      title: Type.String(),
      url: Type.String(),
    }),
  ),
});
const CookiesSchema = Type.Object({ cookies: Type.Array(CookieSchema) });
const SetSchema = Type.Object({ success: Type.Boolean() });
const NavigatedSchema = Type.Object({ errorText: Type.Optional(Type.String()) });
const PausedSchema = Type.Object({ requestId: Type.String() });
const EvaluatedSchema = Type.Object({
  result: Type.Object({ value: Type.Optional(Type.Unknown()) }),
  exceptionDetails: Type.Optional(Type.Object({ text: Type.String() })),
});

export interface Page {
  readonly id: string;
  readonly title: string;
  readonly url: string;
}

export async function pagesOf(cdp: Cdp): Promise<Page[]> {
  const listed = parseCdp(TargetsSchema, await cdp.send("Target.getTargets"), "the target list");
  return listed.targetInfos
    .filter((each) => each.type === "page")
    .map((each) => ({ id: each.targetId, title: each.title, url: each.url }));
}

export async function blankPage(cdp: Cdp): Promise<string> {
  const created = await cdp.send("Target.createTarget", { url: "about:blank" });
  return parseCdp(CreatedSchema, created, "the new tab").targetId;
}

export async function closePages(cdp: Cdp, keep: string): Promise<void> {
  const deadline = Date.now() + CLOSE_MS;
  for (;;) {
    const others = (await pagesOf(cdp)).filter((each) => each.id !== keep);
    if (others.length === 0) return;
    if (Date.now() > deadline) throw new Error("Chrome did not close its pages");
    for (const page of others)
      await cdp.send("Target.closeTarget", { targetId: page.id }).catch(() => undefined);
    await sleep(50);
  }
}

export async function attach(cdp: Cdp, target: string): Promise<string> {
  const attached = await cdp.send("Target.attachToTarget", { targetId: target, flatten: true });
  return parseCdp(AttachedSchema, attached, "the attachment").sessionId;
}

async function evaluate(cdp: Cdp, sessionId: string, expression: string): Promise<unknown> {
  const done = parseCdp(
    EvaluatedSchema,
    await cdp.send(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true },
      { sessionId },
    ),
    "the page's answer",
  );
  if (done.exceptionDetails !== undefined)
    throw new Error(`the page would not run the read: ${done.exceptionDetails.text}`);
  return done.result.value;
}

export async function readCookies(
  cdp: Cdp,
  sessionId: string,
  urls: readonly string[],
): Promise<Cookie[]> {
  const answer = await cdp.send("Network.getCookies", { urls }, { sessionId });
  return parseCdp(CookiesSchema, answer, "the cookies").cookies;
}

function cookieParams(cookie: Cookie): Record<string, unknown> {
  const shared = {
    name: cookie.name,
    value: cookie.value,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    ...(cookie.sameSite === undefined ? {} : { sameSite: cookie.sameSite }),
    ...(cookie.priority === undefined ? {} : { priority: cookie.priority }),
    ...(cookie.session ? {} : { expires: cookie.expires }),
    ...(cookie.partitionKey === undefined ? {} : { partitionKey: cookie.partitionKey }),
  };
  if (cookie.domain.startsWith(".")) return { ...shared, domain: cookie.domain };
  return { ...shared, url: `${cookie.secure ? "https" : "http"}://${cookie.domain}${cookie.path}` };
}

export async function replaceCookies(
  cdp: Cdp,
  sessionId: string,
  urls: readonly string[],
  cookies: readonly Cookie[],
): Promise<string[]> {
  for (const old of await readCookies(cdp, sessionId, urls))
    await cdp.send(
      "Network.deleteCookies",
      {
        name: old.name,
        domain: old.domain,
        path: old.path,
        ...(old.partitionKey === undefined ? {} : { partitionKey: old.partitionKey }),
      },
      { sessionId },
    );
  const refused: string[] = [];
  for (const cookie of cookies) {
    const done = parseCdp(
      SetSchema,
      await cdp.send("Network.setCookie", cookieParams(cookie), { sessionId }),
      "the cookie answer",
    );
    if (!done.success) refused.push(cookie.name);
  }
  return refused;
}

const onlyOn = (origin: string, otherwise: string): string =>
  `if (location.origin !== ${JSON.stringify(origin)}) return ${otherwise};`;

export async function readStorage(
  cdp: Cdp,
  sessionId: string,
  origin: string,
): Promise<Storage | undefined> {
  const text = await evaluate(
    cdp,
    sessionId,
    `(() => { ${onlyOn(origin, "null")} return JSON.stringify(Array.from({ length: localStorage.length }, (_, at) => { const key = localStorage.key(at); return [key, localStorage.getItem(key)]; })); })()`,
  ).catch(() => null);
  if (text === null) return undefined;
  if (typeof text !== "string") throw new Error("the page gave no storage");
  const parsed: unknown = JSON.parse(text);
  return parseCdp(StorageSchema, parsed, "the page's storage");
}

export async function replaceStorage(
  cdp: Cdp,
  sessionId: string,
  origin: string,
  storage: Storage,
): Promise<boolean> {
  const done = await evaluate(
    cdp,
    sessionId,
    `(() => { ${onlyOn(origin, "false")} localStorage.clear(); for (const [key, value] of ${JSON.stringify(storage)}) localStorage.setItem(key, value); return true; })()`,
  ).catch(() => false);
  return done === true;
}

export async function clearOrigin(cdp: Cdp, sessionId: string, origin: string): Promise<void> {
  await cdp.send("Storage.clearDataForOrigin", { origin, storageTypes: "all" }, { sessionId });
}

function loadEvent(cdp: Cdp, sessionId: string): { done: Promise<void>; stop: () => void } {
  let stop = (): void => undefined;
  const done = new Promise<void>((resolve) => {
    stop = cdp.listen((event) => {
      if (event.sessionId === sessionId && event.method === "Page.loadEventFired") resolve();
    });
    cdp.onClose(resolve);
  });
  return { done, stop };
}

export async function navigate(
  cdp: Cdp,
  sessionId: string,
  url: string,
): Promise<string | undefined> {
  await cdp.send("Page.enable", {}, { sessionId });
  const loaded = loadEvent(cdp, sessionId);
  const timer = new AbortController();
  try {
    const answer = parseCdp(
      NavigatedSchema,
      await cdp.send("Page.navigate", { url }, { sessionId }),
      "the navigation",
    );
    if (answer.errorText !== undefined) return answer.errorText;
    await Promise.race([
      loaded.done,
      sleep(LOAD_MS, undefined, { signal: timer.signal }).catch(() => undefined),
    ]);
    return undefined;
  } finally {
    timer.abort();
    loaded.stop();
  }
}

export async function landOn(cdp: Cdp, sessionId: string, origin: string): Promise<void> {
  const stub = `${origin}${STUB_PATH}`;
  const stop = cdp.listen((event) => {
    if (
      event.sessionId === sessionId &&
      event.method === "Fetch.requestPaused" &&
      Value.Check(PausedSchema, event.params)
    )
      void cdp
        .send(
          "Fetch.fulfillRequest",
          {
            requestId: event.params.requestId,
            responseCode: 200,
            responseHeaders: [{ name: "content-type", value: "text/html" }],
            body: STUB_PAGE,
          },
          { sessionId },
        )
        .catch(() => undefined);
  });
  try {
    await cdp.send("Fetch.enable", { patterns: [{ urlPattern: stub }] }, { sessionId });
    const failure = await navigate(cdp, sessionId, stub);
    if (failure !== undefined) throw new Error(`Chrome could not open ${origin}: ${failure}`);
  } finally {
    stop();
    await cdp.send("Fetch.disable", {}, { sessionId }).catch(() => undefined);
  }
}
