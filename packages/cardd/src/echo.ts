import type { DatabaseSync } from "node:sqlite";
import type { Card } from "@fleet/protocol";
import { cardEntries, parentOf, type Session } from "./store.ts";

const ACTIONS: ReadonlySet<string> = new Set(["comment", "hold", "release", "cleanup", "status"]);

function echoTo(
  db: DatabaseSync,
  session: Session,
  card: Card,
): { readonly to: readonly string[]; readonly re?: string } {
  const parent = parentOf(db, session.lane);
  if (parent === null || card.lane !== session.lane) return { to: [] };
  const entries = cardEntries(db, card.id);
  const asked = entries.findLast(
    (entry) =>
      entry.author === `mate:${parent}` &&
      entry.kind === "comment" &&
      entry.fields["for"] === "mate",
  );
  if (asked === undefined) return { to: [] };
  const acted = entries.some(
    (entry) =>
      entry.id > asked.id &&
      entry.author === `mate:${session.lane}` &&
      entry.fields["task"] !== true &&
      ACTIONS.has(entry.kind),
  );
  return acted ? { to: [] } : { to: [parent], re: asked.body };
}

export function withEcho(
  db: DatabaseSync,
  session: Session,
  card: Card,
  to: readonly string[],
  fields: Record<string, unknown>,
): { to: string[]; fields: Record<string, unknown> } {
  const echo = echoTo(db, session, card);
  const both = [...new Set([...to, ...echo.to])];
  return { to: both, fields: echo.re === undefined ? fields : { ...fields, re: echo.re } };
}
