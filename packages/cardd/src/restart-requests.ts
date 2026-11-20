import type { DatabaseSync } from "node:sqlite";
import type { Card } from "@fleet/protocol";
import { intentOf } from "./incident-lifecycle.ts";

export const LIVE_REQUEST = `json_extract(e.fields, '$.restartKey') IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM entries f WHERE f.card = e.card AND f.kind = 'note' AND f.id > e.id
    AND json_extract(f.fields, '$.restartFailed') = e.id)`;

export function requestKey(db: DatabaseSync, card: number, request: number): string | undefined {
  const row = db
    .prepare(
      `SELECT json_extract(e.fields, '$.restartKey') AS key FROM entries e
       WHERE e.id = ? AND e.card = ? AND e.kind = 'note' AND ${LIVE_REQUEST}`,
    )
    .get(request, card);
  return typeof row?.["key"] === "string" ? row["key"] : undefined;
}

export function noticeEligible(db: DatabaseSync, card: Card, request: number): boolean {
  return (
    requestKey(db, card.id, request) !== undefined &&
    card.status === "working" &&
    intentOf(db, card.id, "worker") === "working"
  );
}
