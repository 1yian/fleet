import type { DatabaseSync } from "node:sqlite";
import { idlePark, waitLine, type DatedWait, type Entry } from "@fleet/protocol";
import { factsFrom, finishedOpen, type Standing } from "./status.ts";
import { cardEntries, type Loaded, mainLane, parentOf } from "./store.ts";
import { MINUTE, type Timings } from "./timing.ts";
import { canSee, sightOf } from "./waits.ts";

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

type Group = "act" | "captain" | "watched";

interface Item {
  readonly card: number;
  readonly since: number;
  readonly to: string;
  readonly line: string;
  readonly group: Group;
}

const BUNDLE = "decisions";

export const readableBy = (db: DatabaseSync, lane: string, entry: Entry): boolean =>
  entry.author !== "check" ||
  entry.fields["condition"] !== BUNDLE ||
  canSee(db, lane, entry.fields["to"]);

function captainItem(
  db: DatabaseSync,
  card: Loaded["card"],
  standing: Standing,
  now: number,
): Item {
  const main = mainLane(db);
  const question = firstLine(standing.facts.hold?.question ?? "");
  const line = `c-${String(card.id)} ${card.title} - waiting on the captain (${waited(now, standing.since)}): ${question}`;
  return { card: card.id, since: standing.since, to: main, line, group: "captain" };
}

function mateItem(db: DatabaseSync, loaded: Loaded, now: number): Item[] {
  const { card, entries, standing } = loaded;
  const { hold } = standing.facts;
  const open = standing.status === "with-mate" || standing.status === "merging";
  if (!open || (hold === undefined && finishedOpen(entries) !== undefined)) return [];
  const why = hold === undefined ? standing.status : `${standing.status}, ${hold.holder} hold`;
  const question = hold === undefined ? "" : `: ${firstLine(hold.question)}`;
  const line = `c-${String(card.id)} ${card.title} (${why}, ${waited(now, standing.since)})${question}`;
  return [
    {
      card: card.id,
      since: standing.since,
      to: actingLane(db, card.id, card.lane),
      line,
      group: "act",
    },
  ];
}

function receiver(db: DatabaseSync, card: Loaded["card"], holder: string): string {
  if (holder === "captain") return mainLane(db);
  return holder === "main" ? (parentOf(db, card.lane) ?? card.lane) : card.lane;
}

function waitItem(db: DatabaseSync, loaded: Loaded, wait: DatedWait, now: number): Item {
  const { card, standing } = loaded;
  const { hold } = standing.facts;
  const question = firstLine(hold?.question ?? "");
  const to = receiver(db, card, hold?.holder ?? "owner");
  const line = `c-${String(card.id)} ${card.title} - ${waitLine(sightOf(db, to, card.id, wait), now)}: ${question}`;
  return {
    card: card.id,
    since: standing.since,
    to,
    line,
    group: idlePark(wait) ? "act" : "watched",
  };
}

function openItems(
  db: DatabaseSync,
  cards: readonly Loaded[],
  waits: ReadonlyMap<number, DatedWait>,
  now: number,
): Item[] {
  return cards.flatMap((loaded) => {
    const wait = waits.get(loaded.card.id);
    if (wait !== undefined) return [waitItem(db, loaded, wait, now)];
    return loaded.standing.status === "needs-you"
      ? [captainItem(db, loaded.card, loaded.standing, now)]
      : mateItem(db, loaded, now);
  });
}

const waited = (now: number, since: number): string => `${String(minutesSince(now, since))} min`;

interface LastBundle {
  readonly at: number;
  readonly informed: number;
  readonly count: number;
}

function lastBundle(db: DatabaseSync, to: string): LastBundle {
  const row = db
    .prepare(
      `SELECT count(*) AS count, coalesce(max(created_at), 0) AS at,
         coalesce(max(CASE WHEN json_extract(fields, '$.watched') > 0 THEN created_at END), 0) AS informed
       FROM entries
       WHERE author = 'check' AND json_extract(fields, '$.condition') = ?1
         AND json_extract(fields, '$.to') = ?2`,
    )
    .get(BUNDLE, to);
  return {
    at: Number(row?.["at"]),
    informed: Number(row?.["informed"]),
    count: Number(row?.["count"]),
  };
}

const group = (title: string, items: readonly Item[]): string[] =>
  items.length === 0 ? [] : [`${title}\n${items.map(({ line }) => `- ${line}`).join("\n")}`];

const inGroup = (items: readonly Item[], wanted: Group): Item[] =>
  items.filter(({ group: each }) => each === wanted);

const plural = (n: number, one: string, many: string): string =>
  `${String(n)} ${n === 1 ? one : many}`;

function bundleText(items: readonly Item[]): string {
  const acting = items.filter(({ group: each }) => each !== "watched");
  const watched = inGroup(items, "watched");
  const lead =
    acting.length === 0
      ? `information: ${plural(watched.length, "dated wait", "dated waits")}, nothing needs action`
      : `reminder: ${acting.length === 1 ? "1 card needs" : `${String(acting.length)} cards need`} a decision or action from you`;
  const sections = [
    ...group(
      "You can settle or close these yourself. Act on each now. A dated wait that says nothing is running is an idle park: start what it waits on, or clear the hold and act:",
      inGroup(items, "act"),
    ),
    ...group(
      "Waiting on the captain. Do not list them in chat: they wait on the board. Your role contract says when one may interrupt him. Do not hold a card with a date to quiet it:",
      inGroup(items, "captain"),
    ),
    ...group(
      "Dated waits with something running, an outside date, or the captain's later. Information only, no action now:",
      watched,
    ),
  ];
  return `${lead}. Date a hold only when a process or an outside event is the blocker, or the captain said later, and say what watches it. Never date a hold to quiet a card.\n${sections.join("\n")}`;
}

export function bundleMatches(
  db: DatabaseSync,
  open: readonly Loaded[],
  waits: ReadonlyMap<number, DatedWait>,
  now: number,
  t: Timings,
): BundleMatch[] {
  const byMate = Map.groupBy(
    openItems(db, open, waits, now).sort((a, b) => a.since - b.since || a.card - b.card),
    ({ to }) => to,
  );
  return [...byMate].flatMap(([to, items]): BundleMatch[] => {
    const acting = items.filter(({ group: each }) => each !== "watched");
    const [first] = acting.length > 0 ? acting : items;
    if (first === undefined || now - first.since < (acting.length > 0 ? t.waiting : t.informing))
      return [];
    const last = lastBundle(db, to);
    if (now - last.at < t.waiting) return [];
    if (acting.length === 0 && now - last.informed < t.informing) return [];
    return [
      {
        card: first.card,
        lane: to,
        condition: BUNDLE,
        text: bundleText(items),
        tier: last.count + 1,
        fields: { to, watched: inGroup(items, "watched").length },
      },
    ];
  });
}
