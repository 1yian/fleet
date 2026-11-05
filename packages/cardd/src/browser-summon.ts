import type { DatabaseSync } from "node:sqlite";
import { addEntry, getCard, mainLane } from "./store.ts";

type Place = "lane" | "main";

function mateIsUp(db: DatabaseSync, lane: string): boolean {
  const row = db
    .prepare(
      "SELECT 1 FROM sessions WHERE role = 'mate' AND lane = ? AND state IN ('idle', 'running', 'waiting')",
    )
    .get(lane);
  return row !== undefined;
}

function filed(db: DatabaseSync, card: number, why: string, place: Place): boolean {
  const asked = db
    .prepare(
      `SELECT 1 FROM entries WHERE card = ? AND author = 'browser'
         AND json_extract(fields, '$.summon') = ? AND coalesce(json_extract(fields, '$.place'), 'main') = ?`,
    )
    .get(card, why, place);
  return asked !== undefined;
}

function tell(db: DatabaseSync, card: number, why: string, place: Place, to: string): string[] {
  const { name, lane } = getCard(db, card);
  const whose = lane === mainLane(db) ? "" : ` (lane ${lane})`;
  const body =
    place === "lane"
      ? `c-${String(card)} ${name} needs the captain in its browser tab: ${why}. The fleet shows the tab live in a Browser tab of your workspace when the captain is in it, and otherwise asks main to show it in main's workspace. Tell him once; the worker continues when he is done.`
      : `c-${String(card)} ${name}${whose} needs the captain in its browser tab: ${why}. The fleet opened the Browser tab in your workspace, where he can see the tab live and click and type in it. Tell him once; the worker continues when he is done.`;
  addEntry(
    db,
    { card, author: "browser", kind: "comment", body, fields: { for: "mate", summon: why, place } },
    [to],
  );
  return [to];
}

export function summonCaptain(db: DatabaseSync, card: number, why: string): string[] {
  const main = mainLane(db);
  const { lane } = getCard(db, card);
  const place: Place = lane !== main && mateIsUp(db, lane) ? "lane" : "main";
  if (filed(db, card, why, place)) return [];
  return tell(db, card, why, place, place === "lane" ? lane : main);
}

export function summonMain(db: DatabaseSync, card: number, why: string): string[] {
  if (filed(db, card, why, "main")) return [];
  return tell(db, card, why, "main", mainLane(db));
}
