import type { DatabaseSync } from "node:sqlite";
import { factsFrom, finishFrom, type Standing } from "./status.ts";
import { cardEntries, loadCards, type Loaded, mainLane, parentOf } from "./store.ts";
import { MINUTE, type Timings } from "./timing.ts";

export interface BundleMatch {
  readonly card: number;
  readonly lane: string;
  readonly condition: string;
  readonly text: string;
  readonly tier: number;
  readonly fields: Record<string, unknown>;
}

export function actingLane(db: DatabaseSync, card: number, lane: string): string {
  const { hold } = factsFrom(cardEntries(db, card));
  return hold?.holder === "main" ? (parentOf(db, lane) ?? lane) : lane;
}

export const minutesSince = (now: number, since: number): number =>
  Math.round((now - since) / MINUTE);

const firstLine = (text: string): string =>
  text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line !== "") ?? "";

interface Item {
  readonly card: number;
  readonly since: number;
  readonly to: string;
  readonly line: string;
}

const BUNDLE = "decisions";

function captainItem(
  db: DatabaseSync,
  card: Loaded["card"],
  standing: Standing,
  now: number,
): Item {
  const main = mainLane(db);
  const question = firstLine(standing.facts.hold?.question ?? "");
  const line = `c-${String(card.id)} ${card.title} - waiting on the captain (${waited(now, standing.since)}): ${question}`;
  return { card: card.id, since: standing.since, to: main, line };
}

function mateItem(db: DatabaseSync, loaded: Loaded, now: number): Item[] {
  const { card, entries, standing } = loaded;
  const { hold } = standing.facts;
  const finish = finishFrom(entries);
  const open = standing.status === "with-mate" || standing.status === "merging";
  if (!open || (hold === undefined && (finish.merged || finish.workerDone))) return [];
  const why = hold === undefined ? standing.status : `${standing.status}, ${hold.holder} hold`;
  const question = hold === undefined ? "" : `: ${firstLine(hold.question)}`;
  const line = `c-${String(card.id)} ${card.title} (${why}, ${waited(now, standing.since)})${question}`;
  return [{ card: card.id, since: standing.since, to: actingLane(db, card.id, card.lane), line }];
}

function openItems(db: DatabaseSync, now: number): Item[] {
  return loadCards(db).flatMap((loaded) =>
    loaded.standing.status === "needs-you"
      ? [captainItem(db, loaded.card, loaded.standing, now)]
      : mateItem(db, loaded, now),
  );
}

const waited = (now: number, since: number): string => `${String(minutesSince(now, since))} min`;

function lastBundle(db: DatabaseSync, to: string): { at: number; count: number } {
  const row = db
    .prepare(
      `SELECT count(*) AS count, coalesce(max(created_at), 0) AS at FROM entries
       WHERE author = 'check' AND json_extract(fields, '$.condition') = ?1
         AND json_extract(fields, '$.to') = ?2`,
    )
    .get(BUNDLE, to);
  return { at: Number(row?.["at"]), count: Number(row?.["count"]) };
}

function bundleText(items: readonly Item[]): string {
  const list = items.map(({ line }) => `- ${line}`).join("\n");
  const count = items.length === 1 ? "1 card needs" : `${String(items.length)} cards need`;
  return `reminder: ${count} a decision or action from you. Act on each now. If nothing can be done yet, hold it with until=<date> so reminders stop until then.\n${list}`;
}

export function bundleMatches(db: DatabaseSync, now: number, t: Timings): BundleMatch[] {
  const byMate = Map.groupBy(
    openItems(db, now).sort((a, b) => a.since - b.since || a.card - b.card),
    ({ to }) => to,
  );
  return [...byMate].flatMap(([to, items]): BundleMatch[] => {
    const [first] = items;
    if (first === undefined || now - first.since < t.waiting) return [];
    const last = lastBundle(db, to);
    if (now - last.at < t.waiting) return [];
    const fields = { to };
    return [
      {
        card: first.card,
        lane: to,
        condition: BUNDLE,
        text: bundleText(items),
        tier: last.count + 1,
        fields,
      },
    ];
  });
}
