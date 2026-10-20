// cleanup and card drop (spec sections 7.4 and 20.5). cardd checks the guards and
// gives the mate's extension the attempt's place. The extension stops the
// writers, archives, and removes the worktree, then cardd closes the card.
import type { DatabaseSync } from "node:sqlite";
import { check, OPS, type Card } from "@fleet/protocol";
import { applyChange, requireOrdinary } from "./change.ts";
import { factsFrom, finishFrom } from "./status.ts";
import { withEcho } from "./echo.ts";
import { addEntry, cardEntries, getCard, mainLane, reachable, type Session } from "./store.ts";

interface Done {
  readonly value: unknown;
  readonly notify: readonly string[];
}

/**
 * Done means landed (guard 7, spec section 20.5), judged the way Firstmate did: nothing is
 * left unlanded. A merged PR landed everything. Without one, the worker must have reported
 * done, and a ship card must say that it made no code change (`withoutPr`). The host then
 * confirms for each attempt that no commit is unmerged and the worktree is clean.
 * Returns whether the host must confirm.
 */
function checkLanded(db: DatabaseSync, card: Card, withoutPr: boolean): boolean {
  const name = `c-${String(card.id)}`;
  const { merged, workerDone } = finishFrom(cardEntries(db, card.id));
  if (merged) return false;
  const worked = db.prepare("SELECT 1 FROM attempts WHERE card = ?").get(card.id) !== undefined;
  if (worked && !workerDone) {
    throw new Error(
      `${name} is not finished: the worker has not reported done. Use card_drop if the work will not finish.`,
    );
  }
  if (card.kind === "ship" && !withoutPr) {
    throw new Error(
      `${name} is a ship card with no merged PR. If it made no code change, such as an operation, or its commits are already on the base branch, call cleanup with without_pr set and say so in the summary. Otherwise merge it, or use card_drop.`,
    );
  }
  return card.kind === "ship";
}

function closable(
  db: DatabaseSync,
  session: Session,
  args: { card: number; mode: "done" | "dropped"; withoutPr?: boolean | undefined },
): { card: Card; verify: boolean } {
  const { card } = reachable(db, session, args.card);
  const name = `c-${String(card.id)}`;
  requireOrdinary(db, card);
  if (card.status === "done" || card.status === "dropped")
    throw new Error(`${name} is already ${card.status}`);
  if (factsFrom(cardEntries(db, card.id)).hold !== undefined) {
    throw new Error(
      `${name} has an open hold; release it first, with the captain's words when it waits on him`,
    );
  }
  const verify = args.mode === "done" && checkLanded(db, card, args.withoutPr === true);
  return { card, verify };
}

export function closeBegin(db: DatabaseSync, session: Session, raw: unknown): Done {
  const args = check(OPS["close.begin"].args, raw);
  const { card, verify } = closable(db, session, args);
  const rows = db
    .prepare(
      `SELECT s.id AS session, a.host AS host, a.branch AS branch, coalesce(c.base_branch, p.default_base) AS base,
         json_extract(p.clones, '$."' || a.host || '"') AS clone, a.state IN ('starting', 'active') AS live
       FROM attempts a JOIN cards c ON c.id = a.card JOIN sessions s ON s.attempt = a.id
       LEFT JOIN projects p ON p.name = c.project
       WHERE a.card = ? ORDER BY a.n`,
    )
    .all(card.id);
  const attempts = rows.flatMap((row) => {
    const { session, host, branch, base, clone, live } = row;
    return typeof session === "string" &&
      typeof host === "string" &&
      typeof branch === "string" &&
      typeof base === "string" &&
      typeof clone === "string"
      ? [{ session, host, branch, base, clone, live: live === 1 }]
      : [];
  });
  return { value: { verify, attempts }, notify: [] };
}

export function closeFinish(db: DatabaseSync, session: Session, raw: unknown): Done {
  const args = check(OPS["close.finish"].args, raw);
  const { card } = closable(db, session, args);
  const now = Date.now();
  db.prepare(
    `UPDATE sessions SET state = 'closed' WHERE attempt IN
       (SELECT id FROM attempts WHERE card = ? AND state IN ('starting', 'active'))`,
  ).run(card.id);
  db.prepare(
    "UPDATE attempts SET state = 'ended', updated_at = ? WHERE card = ? AND state IN ('starting', 'active')",
  ).run(now, card.id);
  applyChange(db, card, { kind: args.mode === "done" ? "cleanup" : "drop" });
  // The other mate hears of it: main when a second mate closes its own card,
  // and the card's mate when main closes it. Nobody hears of their own close.
  const main = mainLane(db);
  const other = session.lane === card.lane ? main : card.lane;
  const closed = {
    outcome: args.mode,
    archives: args.archives,
    left: args.left,
    ...(args.withoutPr === true ? { withoutPr: true } : {}),
  };
  const { to, fields } = withEcho(db, session, card, other === session.lane ? [] : [other], closed);
  addEntry(
    db,
    { card: card.id, author: `mate:${session.lane}`, kind: "cleanup", body: args.text, fields },
    to,
  );
  return { value: getCard(db, card.id), notify: to };
}
