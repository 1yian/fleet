import type { Cdp } from "@fleet/protocol";
import type { Dial } from "@fleet/protocol/tunnel";
import {
  attach,
  originOf,
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

async function onOrigin(cdp: Cdp, sessionId: string, origin: string): Promise<boolean> {
  return (await originOf(cdp, sessionId).catch(() => undefined)) === origin;
}

export async function hold(cdp: Cdp, tab: Page, also: readonly string[]): Promise<Session> {
  const origin = new URL(tab.url).origin;
  const urls = [...new Set([`${origin}/`, tab.url, ...also])];
  const sessionId = await attach(cdp, tab.id);
  if (!(await onOrigin(cdp, sessionId, origin)))
    throw new Error(`the tab is not showing ${origin} any more: its storage cannot be read`);
  return {
    origin,
    urls,
    cookies: await readCookies(cdp, sessionId, urls),
    storage: await readStorage(cdp, sessionId),
  };
}

export async function current(cdp: Cdp, tab: Page, held: Session): Promise<Session> {
  const sessionId = await attach(cdp, tab.id);
  const here = await onOrigin(cdp, sessionId, held.origin);
  return {
    ...held,
    cookies: await readCookies(cdp, sessionId, held.urls),
    storage: here ? await readStorage(cdp, sessionId) : undefined,
  };
}

export interface Sent {
  readonly refused: readonly string[];
  readonly storage: boolean;
}

export async function sendBack(cdp: Cdp, tab: Page, session: Session): Promise<Sent> {
  const sessionId = await attach(cdp, tab.id);
  const refused = await replaceCookies(cdp, sessionId, session.urls, session.cookies);
  const here = await onOrigin(cdp, sessionId, session.origin);
  if (here && session.storage !== undefined) await replaceStorage(cdp, sessionId, session.storage);
  await cdp.send("Page.reload", {}, { sessionId });
  return { refused, storage: here && session.storage !== undefined };
}
