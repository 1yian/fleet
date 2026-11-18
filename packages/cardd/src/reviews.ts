import type { DatabaseSync } from "node:sqlite";
import { loadCard, type Session } from "./store.ts";

const LAVISH_POLL =
  /(?:^|[;&|\n])\s*(?:\w+=\S*\s+)*(?:(?:npx\s+(?:-\S+\s+)*)?lavish-axi(?:@[\w.-]+)?|node\s+\S*lavish-axi\/dist\/cli\.mjs)\s+poll\b/;

function unquoted(command: string): string {
  return command.replace(/(["'])((?:(?!\1)[^])*)\1/g, (_, quote: string, inside: string) =>
    /[\s;&|]/.test(inside) ? "" : `${quote}${inside}${quote}`,
  );
}

const NEEDS_DECISION =
  "a Lavish poll waits on the captain, and nothing holds this card yet: report needs-decision with a new review key and the page link first, so your mate sees the wait and can ask the captain, then start the poll again. A working report does not hold the card.";

export function requireReviewDecision(db: DatabaseSync, session: Session, command: string): void {
  if (session.card === null || !LAVISH_POLL.test(unquoted(command))) return;
  if (loadCard(db, session.card).standing.facts.hold === undefined) throw new Error(NEEDS_DECISION);
}
