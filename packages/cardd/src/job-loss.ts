import type { DatabaseSync } from "node:sqlite";
import { loseGoneJob } from "./jobs.ts";
import { addEntry, getCard, type Session } from "./store.ts";

export function loseJobConfirmedGone(
  db: DatabaseSync,
  session: Session,
  job: number,
  silentBefore: number,
): string[] | undefined {
  if (session.card === null) throw new Error("only a worker on a card has jobs");
  const lost = loseGoneJob(db, session.id, job, silentBefore);
  if (lost === undefined) return undefined;
  const card = getCard(db, session.card);
  const named = `job ${String(job)} (${lost.label})`;
  addEntry(
    db,
    {
      card: card.id,
      author: "check",
      kind: "finding",
      body: `job lost: ${named} is gone: its process no longer runs, and no result arrived. It is not run again.`,
      fields: { condition: "job-lost", job },
    },
    [card.lane],
  );
  addEntry(
    db,
    {
      card: card.id,
      author: `job:${String(job)}`,
      kind: "job-result",
      body: "its process is gone, and no result arrived. It is not run again.",
      fields: { job, label: lost.label, lost: true },
    },
    [session.id],
  );
  return [card.lane, session.id];
}
