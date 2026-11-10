import type { Cdp } from "@fleet/protocol";
import type { Dial } from "@fleet/protocol/tunnel";
import {
  attach,
  pagesOf,
  readCookies,
  readStorage,
  replaceCookies,
  replaceStorage,
  type Page,
} from "./takeover-page.ts";
import type { Session } from "./takeover-session.ts";

export async function tabsOf(cdp: Cdp): Promise<Page[]> {
  return (await pagesOf(cdp)).filter((each) => /^https?:\/\//.test(each.url));
}

export async function through<T>(via: Dial, run: (cdp: Cdp) => Promise<T>): Promise<T> {
  const cdp = await via.connect();
  try {
    return await run(cdp);
  } finally {
    cdp.close();
  }
}

export async function hold(cdp: Cdp, tab: Page): Promise<Session> {
  const origin = new URL(tab.url).origin;
  const urls = [...new Set([`${origin}/`, tab.url])];
  const sessionId = await attach(cdp, tab.id);
  const cookies = await readCookies(cdp, sessionId, urls);
  const storage = await readStorage(cdp, sessionId, origin);
  if (storage === undefined)
    throw new Error(`the tab is not showing ${origin} any more: its storage cannot be read`);
  return { origin, urls, cookies, storage };
}

export async function current(cdp: Cdp, tab: Page, held: Session): Promise<Session> {
  const sessionId = await attach(cdp, tab.id);
  return {
    ...held,
    cookies: await readCookies(cdp, sessionId, held.urls),
    storage: await readStorage(cdp, sessionId, held.origin),
  };
}

export interface Sent {
  readonly refused: readonly string[];
  readonly storage: boolean;
}

export async function sendBack(cdp: Cdp, tab: Page, session: Session): Promise<Sent> {
  const sessionId = await attach(cdp, tab.id);
  const refused = await replaceCookies(cdp, sessionId, session.urls, session.cookies);
  const storage =
    session.storage !== undefined &&
    (await replaceStorage(cdp, sessionId, session.origin, session.storage));
  await cdp.send("Page.reload", {}, { sessionId });
  return { refused, storage };
}
