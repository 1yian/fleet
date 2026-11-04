import type { DatabaseSync } from "node:sqlite";
import { BROWSER_OPS, check, OPS, type OpName } from "@fleet/protocol";
import type { Browser } from "./browser.ts";
import { getCard, mainLane, type Session } from "./store.ts";

export type BrowserOpName = keyof typeof BROWSER_OPS;

export const isBrowserOp = (op: OpName): op is BrowserOpName => Object.hasOwn(BROWSER_OPS, op);

interface Done {
  readonly value: unknown;
  readonly notify: readonly string[];
}

export async function performBrowserOp(
  db: DatabaseSync,
  browser: Browser,
  session: Session,
  op: BrowserOpName,
  raw: unknown,
): Promise<Done> {
  switch (op) {
    case "browser": {
      const done = await browser.run(session, check(OPS.browser.args, raw));
      return { value: done.result, notify: done.notify };
    }
    case "browser.release": {
      const { card } = check(OPS["browser.release"].args, raw);
      if (session.lane !== mainLane(db) && getCard(db, card).lane !== session.lane)
        throw new Error(`c-${String(card)} is in another lane; ask main`);
      return { value: await browser.release(card), notify: [] };
    }
    case "browser.view":
      if (session.lane !== mainLane(db)) throw new Error("only main can view the shared browser");
      return { value: browser.view(), notify: [] };
  }
}
