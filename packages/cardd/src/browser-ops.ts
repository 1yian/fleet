import type { DatabaseSync } from "node:sqlite";
import { BROWSER_OPS, check, OPS, type BrowserArgs, type OpName } from "@fleet/protocol";
import type { Browser } from "./browser.ts";
import { isOwnBuild } from "./browser-build.ts";
import { openTabs, type Tab } from "./browser-store.ts";
import { summonCaptain, summonMain } from "./browser-summon.ts";
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

function summon(
  db: DatabaseSync,
  browser: Browser,
  card: number,
  why: string,
  declared: string | undefined,
): string[] {
  const asked = summonCaptain(db, card, why);
  if (asked.length > 0) void browser.raise(card, declared);
  return asked;
}

function summoned(
  db: DatabaseSync,
  browser: Browser,
  card: number,
  why: string | undefined,
  declared: string | undefined,
  error: unknown,
): Error {
  if (why === undefined || !browser.hasTab(card, declared))
    return error instanceof Error ? error : new Error(reason(error));
  const refusal = reason(error).replace(/\.?\s*$/, "");
  return new Summoned(
    `${refusal}. The captain was asked to open the tab: ${why}.`,
    summon(db, browser, card, why, declared),
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

function visibleTab(db: DatabaseSync, session: Session, target: string): Tab {
  const wants = sees(db, session, undefined);
  const tab = openTabs(db).find((each) => each.target === target && wants(each.card));
  if (tab === undefined) throw new Error("that tab is not open, or it is not yours to see");
  return tab;
}

function declaredHost(session: Session, named: string | undefined): string | undefined {
  if (session.card === null) return named;
  if (named !== undefined)
    throw new Error("your browser is on the host that your worker runs on: do not name a host");
  return undefined;
}

function laneOnly(db: DatabaseSync, session: Session, card: number): void {
  if (session.lane !== mainLane(db) && getCard(db, card).lane !== session.lane)
    throw new Error(`c-${String(card)} is in another lane; ask main`);
}

async function browse(
  db: DatabaseSync,
  browser: Browser,
  session: Session,
  args: BrowserArgs,
): Promise<Done> {
  const card = cardOf(db, session, args.card);
  const declared = declaredHost(session, args.host);
  const done = await browser.run(card, args, declared).catch((error: unknown) => {
    throw summoned(db, browser, card, args.captain, declared, error);
  });
  const why = args.captain ?? done.captain;
  const asked = why === undefined ? [] : summon(db, browser, card, why, declared);
  const result = why === undefined ? done.result : { ...done.result, captain: why };
  return { value: result, notify: [...done.notify, ...asked] };
}

async function viewOf(
  db: DatabaseSync,
  browser: Browser,
  session: Session,
  raw: unknown,
): Promise<Done> {
  const { card: named, captain, host: declared, build } = check(OPS["browser.view"].args, raw);
  if (captain === true) captainOnly(db, session);
  const asked = declaredHost(session, declared);
  const own = session.card;
  const where =
    own !== null
      ? browser.hostOf(own, undefined)
      : named === undefined
        ? asked
        : browser.hostOf(named, asked);
  return {
    value: {
      ...(await browser.view(sees(db, session, named), captain === true, where, isOwnBuild(build))),
      canNameHost: own === null,
    },
    notify: [],
  };
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
      laneOnly(db, session, card);
      return { value: await browser.release(card), notify: [] };
    }
    case "browser.summon": {
      const { card, why } = check(OPS["browser.summon"].args, raw);
      laneOnly(db, session, card);
      const told = summonMain(db, card, why);
      return { value: { told: told.length > 0 }, notify: told };
    }
    case "browser.view":
      return viewOf(db, browser, session, raw);
    case "browser.frame": {
      const { target } = check(OPS["browser.frame"].args, raw);
      const tab = visibleTab(db, session, target);
      return { value: await browser.frame(tab.card, tab.target), notify: [] };
    }
    case "browser.held": {
      check(OPS["browser.held"].args, raw);
      return { value: await browser.held(sees(db, session, undefined)), notify: [] };
    }
    case "browser.entered": {
      const { target } = check(OPS["browser.entered"].args, raw);
      const tab = visibleTab(db, session, target);
      return { value: await browser.enter(tab.card, tab.target), notify: [] };
    }
    case "browser.copy": {
      const { target } = check(OPS["browser.copy"].args, raw);
      const tab = visibleTab(db, session, target);
      return { value: await browser.copy(tab.card, tab.target), notify: [] };
    }
  }
}
