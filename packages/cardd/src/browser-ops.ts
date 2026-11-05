import type { DatabaseSync } from "node:sqlite";
import { BROWSER_OPS, check, OPS, type BrowserArgs, type OpName } from "@fleet/protocol";
import type { Browser } from "./browser.ts";
import { summonCaptain } from "./browser-summon.ts";
import { getCard, mainLane, type Session } from "./store.ts";

export type BrowserOpName = keyof typeof BROWSER_OPS;

export const isBrowserOp = (op: OpName): op is BrowserOpName => Object.hasOwn(BROWSER_OPS, op);

interface Done {
  readonly value: unknown;
  readonly notify: readonly string[];
}

function cardOf(db: DatabaseSync, session: Session, named: number | undefined): number {
  if (session.card !== null) {
    if (named !== undefined && named !== session.card)
      throw new Error(`your tab is c-${String(session.card)}'s: do not name another card`);
    return session.card;
  }
  if (named === undefined)
    throw new Error("name the card whose tab you drive: pass the card number (--card N)");
  if (session.lane !== mainLane(db) && getCard(db, named).lane !== session.lane)
    throw new Error(`c-${String(named)} is in another lane; ask main`);
  return named;
}

async function browse(
  db: DatabaseSync,
  browser: Browser,
  session: Session,
  args: BrowserArgs,
): Promise<Done> {
  const card = cardOf(db, session, args.card);
  const done = await browser.run(card, args);
  const why = args.captain ?? done.captain;
  const asked = why === undefined ? [] : summonCaptain(db, card, why);
  const result = why === undefined ? done.result : { ...done.result, captain: why };
  return { value: result, notify: [...done.notify, ...asked] };
}

export async function performBrowserOp(
  db: DatabaseSync,
  browser: Browser,
  session: Session,
  op: BrowserOpName,
  raw: unknown,
): Promise<Done> {
  switch (op) {
    case "browser":
      return browse(db, browser, session, check(OPS.browser.args, raw));
    case "browser.release": {
      const { card } = check(OPS["browser.release"].args, raw);
      if (session.lane !== mainLane(db) && getCard(db, card).lane !== session.lane)
        throw new Error(`c-${String(card)} is in another lane; ask main`);
      return { value: await browser.release(card), notify: [] };
    }
    case "browser.view": {
      const { card: named } = check(OPS["browser.view"].args, raw);
      const own = session.card;
      const everything = own === null && session.lane === mainLane(db);
      const mine = (card: number): boolean => everything || getCard(db, card).lane === session.lane;
      const wants = (card: number): boolean =>
        own !== null
          ? card === own
          : named === undefined
            ? mine(card)
            : card === named && mine(card);
      return { value: browser.view(wants), notify: [] };
    }
  }
}
