import type { DatabaseSync } from "node:sqlite";
import { loadCard, type Session } from "./store.ts";

const LAVISH_POLL = /\blavish-axi(?:@[\w.-]+|\/[^\s;&|]*|['"])?\s+poll\b/;

const NEEDS_DECISION =
  "a Lavish poll waits on the captain, and nothing holds this card yet: report needs-decision with a new review key and the page link first, so your mate sees the wait and can ask the captain, then start the poll again. A working report does not hold the card.";

export function requireReviewDecision(db: DatabaseSync, session: Session, command: string): void {
  if (session.card === null || !LAVISH_POLL.test(command)) return;
  if (loadCard(db, session.card).standing.facts.hold === undefined) throw new Error(NEEDS_DECISION);
}
