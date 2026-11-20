import type { DatabaseSync } from "node:sqlite";
import type { Card } from "@fleet/protocol";
import { intentOf } from "./incident-lifecycle.ts";

export const LIVE_REQUEST = `json_extract(e.fields, '$.restartKey') IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM entries f WHERE f.card = e.card AND f.kind = 'note' AND f.id > e.id
    AND json_extract(f.fields, '$.restartFailed') = e.id)`;

interface Request {
  readonly key: string;
  readonly actor: string;
  readonly generation: number;
}

export function requestOf(db: DatabaseSync, card: number, request: number): Request | undefined {
  const row = db
    .prepare(
      `SELECT json_extract(e.fields, '$.restartKey') AS key,
              json_extract(e.fields, '$.actor') AS actor,
              json_extract(e.fields, '$.generation') AS generation
       FROM entries e WHERE e.id = ? AND e.card = ? AND e.kind = 'note' AND ${LIVE_REQUEST}`,
    )
    .get(request, card);
  const key = row?.["key"];
  const actor = row?.["actor"];
  const generation = row?.["generation"];
  return typeof key === "string" && typeof actor === "string" && typeof generation === "number"
    ? { key, actor, generation }
    : undefined;
}

export function noticeEligible(db: DatabaseSync, card: Card, request: number): boolean {
  return (
    card.status === "working" &&
    requestOf(db, card.id, request) !== undefined &&
    db
      .prepare(
        `SELECT 1 FROM entries e WHERE e.card = ? AND e.id > ? AND (
        (e.kind = 'note' AND ${LIVE_REQUEST}) OR
        (e.kind = 'comment' AND json_extract(e.fields, '$.recoveryMode') = 'replace')
      ) LIMIT 1`,
      )
      .get(card.id, request) === undefined &&
    intentOf(db, card.id, "worker") === "working"
  );
}
