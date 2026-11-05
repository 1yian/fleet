import type { DatabaseSync } from "node:sqlite";
import { BROWSER_OPS, check, OPS, type BrowserArgs, type OpName } from "@fleet/protocol";
import type { Browser } from "./browser.ts";
import { openTabs } from "./browser-store.ts";
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

export class Summoned extends Error {
  readonly notify: readonly string[];

  constructor(message: string, notify: readonly string[], cause: unknown) {
    super(message, { cause });
    this.notify = notify;
  }
}

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function summoned(
  db: DatabaseSync,
  browser: Browser,
  card: number,
  why: string | undefined,
  error: unknown,
): Error {
  if (why === undefined || !browser.hasTab(card))
    return error instanceof Error ? error : new Error(reason(error));
  const refusal = reason(error).replace(/\.?\s*$/, "");
  return new Summoned(
    `${refusal}. The captain was asked to open the tab: ${why}.`,
    summonCaptain(db, card, why),
    error,
  );
}

const isMainItself = (db: DatabaseSync, session: Session): boolean =>
  session.card === null && session.lane === mainLane(db);

function captainOnly(db: DatabaseSync, session: Session): void {
  if (!isMainItself(db, session))
    throw new Error("only main's own session may ask for the captain's view of a tab");
}

function sees(
  db: DatabaseSync,
  session: Session,
  named: number | undefined,
): (card: number) => boolean {
  const own = session.card;
  const everything = isMainItself(db, session);
  const mine = (card: number): boolean => everything || getCard(db, card).lane === session.lane;
  return (card) =>
    own !== null ? card === own : named === undefined ? mine(card) : card === named && mine(card);
}

async function browse(
  db: DatabaseSync,
  browser: Browser,
  session: Session,
  args: BrowserArgs,
): Promise<Done> {
  const card = cardOf(db, session, args.card);
  const done = await browser.run(card, args).catch((error: unknown) => {
    throw summoned(db, browser, card, args.captain, error);
  });
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
      const { card: named, captain } = check(OPS["browser.view"].args, raw);
      if (captain === true) captainOnly(db, session);
      return {
        value: await browser.view(sees(db, session, named), captain === true),
        notify: [],
      };
    }
    case "browser.clear": {
      const { target, captain } = check(OPS["browser.clear"].args, raw);
      if (captain === true) {
        captainOnly(db, session);
        return { value: { clear: true, note: null }, notify: [] };
      }
      const wants = sees(db, session, undefined);
      const tab = openTabs(db).find((each) => each.target === target && wants(each.card));
      if (tab === undefined) throw new Error("that tab is not open, or it is not yours to see");
      return { value: await browser.clear(tab.card, tab.target), notify: [] };
    }
  }
}
