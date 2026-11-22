import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Card, Entry, GrokReportArgs, OpResult } from "@fleet/protocol";
import { requireOpen } from "./change.ts";
import { addEntry, cardEntries, loadCard, transaction } from "./store.ts";

const AUTHOR = "grok-bot";

function currentAttempt(db: DatabaseSync, card: number, assignment: string): number | undefined {
  const attempt = db
    .prepare(
      `SELECT json_extract(fields, '$.attempt') AS attempt FROM entries WHERE card = ? AND kind = 'note'
       AND json_extract(fields, '$.grok') = 'assignment' AND json_extract(fields, '$.assignment') = ?
       ORDER BY id DESC LIMIT 1`,
    )
    .get(card, assignment)?.["attempt"];
  return typeof attempt === "number" ? attempt : undefined;
}

function recordedResult(entries: readonly Entry[], assignment: string): Entry | undefined {
  return entries.find(
    (entry) => entry.author === AUTHOR && entry.fields["assignment"] === assignment,
  );
}

function retryAttempt(db: DatabaseSync, card: Card, assignment: string): number {
  const attempt = currentAttempt(db, card.id, assignment);
  if (attempt === undefined) throw new Error("no such Grok Bot assignment on this card");
  if (recordedResult(cardEntries(db, card.id), assignment) !== undefined)
    throw new Error("this Grok Bot assignment already has a result; create a new assignment");
  return attempt + 1;
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
  const attempt = previous === undefined ? 1 : retryAttempt(db, card, previous);
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
    const current = currentAttempt(db, id, assignment);
    if (current === undefined || attempt > current) return { receipt: "uncorrelated" } as const;
    const { card, entries } = loadCard(db, id);
    if (attempt < current || card.status === "done" || card.status === "dropped")
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
