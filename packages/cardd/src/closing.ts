// cleanup and card drop (spec sections 7.4 and 20.5). cardd checks the guards and
// gives the mate's extension the attempt's place. The extension stops the
// writers, archives, and removes the worktree, then cardd closes the card.
import type { DatabaseSync } from "node:sqlite";
import { check, OPS, type Card } from "@fleet/protocol";
import { reachable } from "./asks.ts";
import { applyChange } from "./change.ts";
import { factsFrom } from "./status.ts";
import { addEntry, cardEntries, getCard, mainLane, type Session } from "./store.ts";

interface Done {
  readonly value: unknown;
  readonly notify: readonly string[];
}

/** Done means landed (guard 7): a merged ship card, or any other card whose work was delivered. */
function landed(db: DatabaseSync, card: Card): boolean {
  if (card.kind !== "ship") return true;
  return cardEntries(db, card.id).some(
    (entry) =>
      entry.kind === "merge" ||
      (entry.kind === "finding" && entry.fields["condition"] === "pr-merged"),
  );
}

function closable(db: DatabaseSync, session: Session, id: number, mode: "done" | "dropped"): Card {
  const { card } = reachable(db, session, id);
  const name = `c-${String(card.id)}`;
  if (card.status === "done" || card.status === "dropped")
    throw new Error(`${name} is already ${card.status}`);
  if (factsFrom(cardEntries(db, card.id)).openAsks > 0) {
    throw new Error(
      `${name} has an open question; the captain answers it, or agrees that it is moot, first`,
    );
  }
  if (mode === "done" && !landed(db, card)) {
    throw new Error(
      `${name} has not landed; cleanup is for merged or delivered work. Use card_drop.`,
    );
  }
  return card;
}

export function closeBegin(db: DatabaseSync, session: Session, raw: unknown): Done {
  const args = check(OPS["close.begin"].args, raw);
  const card = closable(db, session, args.card, args.mode);
  const rows = db
    .prepare(
      `SELECT s.id AS session, a.host AS host, a.branch AS branch, coalesce(c.base_branch, p.default_base) AS base,
         json_extract(p.clones, '$."' || a.host || '"') AS clone
       FROM attempts a JOIN cards c ON c.id = a.card JOIN sessions s ON s.attempt = a.id
       LEFT JOIN projects p ON p.name = c.project
       WHERE a.card = ? ORDER BY a.n`,
    )
    .all(card.id);
  const attempts = rows.flatMap((row) => {
    const { session, host, branch, base, clone } = row;
    return typeof session === "string" &&
      typeof host === "string" &&
      typeof branch === "string" &&
      typeof base === "string" &&
      typeof clone === "string"
      ? [{ session, host, branch, base, clone }]
      : [];
  });
  return { value: { attempts }, notify: [] };
}

export function closeFinish(db: DatabaseSync, session: Session, raw: unknown): Done {
  const args = check(OPS["close.finish"].args, raw);
  const card = closable(db, session, args.card, args.mode);
  const now = Date.now();
  db.prepare(
    `UPDATE sessions SET state = 'closed' WHERE attempt IN
       (SELECT id FROM attempts WHERE card = ? AND state IN ('starting', 'active'))`,
  ).run(card.id);
  db.prepare(
    "UPDATE attempts SET state = 'ended', updated_at = ? WHERE card = ? AND state IN ('starting', 'active')",
  ).run(now, card.id);
  applyChange(db, card, { kind: args.mode === "done" ? "cleanup" : "drop" });
  const main = mainLane(db);
  const to = main === card.lane ? [] : [main];
  const fields = { outcome: args.mode, archives: args.archives };
  addEntry(
    db,
    { card: card.id, author: `mate:${session.lane}`, kind: "cleanup", body: args.text, fields },
    to,
  );
  return { value: getCard(db, card.id), notify: to };
}
