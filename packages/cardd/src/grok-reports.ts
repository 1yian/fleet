import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Card, Entry, GrokReportArgs, OpResult } from "@fleet/protocol";
import { requireOpen } from "./change.ts";
import { addEntry, cardEntries, loadCard, transaction } from "./store.ts";

const AUTHOR = "grok-bot";

function attemptsOf(db: DatabaseSync, card: number, assignment: string): string[] {
  return db
    .prepare(
      `SELECT json_extract(fields, '$.attempt') AS attempt FROM entries WHERE card = ? AND kind = 'note'
       AND json_extract(fields, '$.grok') = 'assignment' AND json_extract(fields, '$.assignment') = ?
       ORDER BY id DESC`,
    )
    .all(card, assignment)
    .flatMap((row) => (typeof row["attempt"] === "string" ? [row["attempt"]] : []));
}

function recordedResult(entries: readonly Entry[], assignment: string): Entry | undefined {
  return entries.find(
    (entry) => entry.author === AUTHOR && entry.fields["assignment"] === assignment,
  );
}

function requireRetryable(db: DatabaseSync, card: Card, assignment: string): void {
  if (attemptsOf(db, card.id, assignment).length === 0)
    throw new Error("no such Grok Bot assignment on this card");
  if (recordedResult(cardEntries(db, card.id), assignment) !== undefined)
    throw new Error("this Grok Bot assignment already has a result; create a new assignment");
}

export function assignGrokReport(
  db: DatabaseSync,
  card: Card,
  previous: string | undefined,
): OpResult<"grok.assign"> {
  if (process.env["CARDD_GROK_REPORT_TOKEN"] === undefined)
    throw new Error("the Grok Bot reporting connector is not enabled");
  requireOpen(db, card);
  const assignment = previous ?? randomUUID();
  if (previous !== undefined) requireRetryable(db, card, previous);
  const attempt = randomUUID();
  addEntry(
    db,
    {
      card: card.id,
      author: `mate:${card.lane}`,
      kind: "note",
      body:
        previous === undefined
          ? "Assigned a reporting-only task to Grok Bot"
          : "Reissued a reporting-only Grok Bot assignment",
      fields: { grok: "assignment", assignment, attempt },
    },
    [],
  );
  return { card: card.id, assignment, attempt };
}

export function recordGrokReport(
  db: DatabaseSync,
  { card: id, assignment, attempt, text, sources }: GrokReportArgs,
) {
  return transaction(db, () => {
    const attempts = attemptsOf(db, id, assignment);
    if (!attempts.includes(attempt)) return { receipt: "uncorrelated" } as const;
    const { card, entries } = loadCard(db, id);
    if (attempt !== attempts[0] || card.status === "done" || card.status === "dropped")
      return { receipt: "stale" } as const;
    const prior = recordedResult(entries, assignment);
    if (prior !== undefined) {
      const same =
        prior.body === text && JSON.stringify(prior.fields["sources"]) === JSON.stringify(sources);
      return { receipt: same ? "duplicate" : "conflict", entry: prior.id } as const;
    }
    const entry = addEntry(
      db,
      {
        card: id,
        kind: "note",
        author: AUTHOR,
        body: text,
        fields: { grok: "result", assignment, attempt, sources },
      },
      [card.lane],
    );
    return { receipt: "recorded", entry, recipient: card.lane } as const;
  });
}
