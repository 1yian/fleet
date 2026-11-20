import type { DatabaseSync } from "node:sqlite";
import { QUEUED_DELIVERY } from "./delivery-states.ts";
import { acceptsRestartNotice } from "./status.ts";
import { loadCard } from "./store.ts";

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

export function noticeState(
  db: DatabaseSync,
  card: number,
  request: number,
): "eligible" | "suppressed" | "retired" {
  const now = Date.now();
  if (
    !acceptsRestartNotice(loadCard(db, card, now), now) ||
    requestOf(db, card, request) === undefined
  )
    return "retired";
  const row = db
    .prepare(
      `SELECT max(CASE
       WHEN e.kind = 'comment' OR s.generation > json_extract(e.fields, '$.generation') THEN 2
       ELSE 1 END) AS supersession
     FROM entries e LEFT JOIN sessions s ON s.id = json_extract(e.fields, '$.actor')
     WHERE e.card = ? AND e.id > ? AND (
       (e.kind = 'note' AND ${LIVE_REQUEST}) OR
       (e.kind = 'comment' AND json_extract(e.fields, '$.recoveryMode') = 'replace')
     )`,
    )
    .get(card, request);
  if (row?.["supersession"] === 2) return "retired";
  return row?.["supersession"] === 1 ? "suppressed" : "eligible";
}

export function releaseRestartNotices(db: DatabaseSync, card: number, refunded: number): string[] {
  const rows = db
    .prepare(
      `SELECT d.session, json_extract(e.fields, '$.restartNotice') AS request
     FROM deliveries d JOIN entries e ON e.id = d.entry
     WHERE e.card = ? AND e.kind = 'comment' AND d.retired_at IS NULL AND d.state IN (${QUEUED_DELIVERY})
       AND json_extract(e.fields, '$.restartNotice') < ?`,
    )
    .all(card, refunded);
  const notify = new Set<string>();
  for (const row of rows) {
    if (noticeState(db, card, Number(row["request"])) === "eligible")
      notify.add(String(row["session"]));
  }
  return [...notify];
}
