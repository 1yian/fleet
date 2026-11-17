import type { DatabaseSync } from "node:sqlite";
import { idlePark, waitLine, type DatedWait, type Entry, type Pulse } from "@fleet/protocol";
import { rotationOf, type Rotation } from "./marks.ts";
import { factsFrom, finishedOpen } from "./status.ts";
import { cardEntries, type Loaded, mainLane, parentOf } from "./store.ts";
import { firstLine } from "./text.ts";
import { MINUTE, type Timings } from "./timing.ts";
import { canSee, holdFor, sightOf } from "./waits.ts";

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

type Group = "act" | "captain" | "watched";

const acts = ({ group }: { readonly group: Group }): boolean => group !== "watched";

interface Item {
  readonly card: number;
  readonly since: number;
  readonly to: string;
  readonly line: string;
  readonly group: Group;
  readonly due?: true;
}

const BUNDLE = "decisions";

export function entryFor(db: DatabaseSync, lane: string, entry: Entry): Entry | undefined {
  const bundle = entry.author === "check" && entry.fields["condition"] === BUNDLE;
  if (bundle) return canSee(db, lane, entry.fields["to"]) ? entry : undefined;
  return holdFor(db, lane, entry);
}

function captainItem(db: DatabaseSync, loaded: Loaded, rotation: Rotation, now: number): Item {
  const { card, standing } = loaded;
  const question = firstLine(standing.facts.hold?.question ?? "");
  const title = `c-${String(card.id)} ${card.title}`;
  const base = {
    card: card.id,
    since: standing.since,
    to: mainLane(db),
    group: "captain" as const,
  };
  if (rotation.due?.card.id === card.id)
    return { ...base, line: `Bring this one up now: ${title}: ${question}`, due: true };
  const shown = rotation.shown.has(card.id) ? " (shown since his last message)" : "";
  return {
    ...base,
    line: `${title} - waiting on the captain (${waited(now, standing.since)}): ${question}${shown}`,
  };
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
  const group = idlePark(wait) ? "act" : "watched";
  const to = receiver(db, card, hold?.holder ?? "owner");
  const since = standing.since;
  const line = `c-${String(card.id)} ${card.title} - ${waitLine(sightOf(db, to, card.id, wait), now)}: ${question}`;
  return { card: card.id, since, to, line, group };
}

function neglectItem(db: DatabaseSync, { card }: Loaded, pulse: Pulse | undefined, now: number) {
  if (pulse === undefined || pulse.notice === "none") return [];
  if (pulse.state !== "idle") return [];
  const name = `c-${String(card.id)} ${card.title}`;
  const since = pulse.movedAt;
  const line = `${name} - idle ${waited(now, since)}, nothing running and no stated reason`;
  return [{ card: card.id, since, to: mainLane(db), line, group: "act" as const }];
}

function openItems(
  db: DatabaseSync,
  cards: readonly Loaded[],
  waits: ReadonlyMap<number, DatedWait>,
  pulses: ReadonlyMap<number, Pulse>,
  rotation: Rotation,
  now: number,
): Item[] {
  return cards.flatMap((loaded) => {
    const wait = waits.get(loaded.card.id);
    const pulse = pulses.get(loaded.card.id);
    if (wait !== undefined) return [waitItem(db, loaded, wait, now)];
    if (loaded.standing.status === "needs-you") return [captainItem(db, loaded, rotation, now)];
    const mate = mateItem(db, loaded, now);
    const neglect = neglectItem(db, loaded, pulse, now);
    return [...mate, ...neglect.filter(({ to }) => mate.every((item) => item.to !== to))];
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

function leadOf(acting: readonly Item[], watched: readonly Item[]): string {
  if (acting.length > 0)
    return `reminder: ${acting.length === 1 ? "1 card needs" : `${String(acting.length)} cards need`} a decision or action from you`;
  return `information: ${plural(watched.length, "dated wait", "dated waits")}, nothing needs action`;
}

const NO_DATE = "Do not hold a card with a date to quiet it:";

function captainHeading(captain: readonly Item[]): string {
  if (!captain.some(({ due }) => due === true))
    return `Waiting on the captain. None is due: he has not written to you since you last brought a decision up, or he is away. Write to him about none of these, and yield unless the list has other work for you. ${NO_DATE}`;
  const others = captain.length - 1;
  const count = others === 0 ? "" : `, and "+${String(others)} more waiting" for the others`;
  return `Waiting on the captain. He has written to you since you last brought a decision up. Bring up the first item now, in one short chat message: the decision and your recommendation${count}. Then call presented(card). Bring up no other one. ${NO_DATE}`;
}

const dueFirst = (items: readonly Item[]): Item[] =>
  items.toSorted((a, b) => Number(b.due === true) - Number(a.due === true));

function bundleText(items: readonly Item[]): string {
  const watched = inGroup(items, "watched");
  const captain = inGroup(items, "captain");
  const lead = leadOf(items.filter(acts), watched);
  const sections = [
    ...group(
      "You can settle or close these yourself. Act on each now. A dated wait that says nothing is running is an idle park: start what it waits on, or clear the hold and act:",
      inGroup(items, "act"),
    ),
    ...group(captainHeading(captain), dueFirst(captain)),
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
  pulses: ReadonlyMap<number, Pulse>,
  now: number,
  t: Timings,
): BundleMatch[] {
  const rotation = rotationOf(db, open);
  const byMate = Map.groupBy(
    openItems(db, open, waits, pulses, rotation, now).sort(
      (a, b) => a.since - b.since || a.card - b.card,
    ),
    ({ to }) => to,
  );
  return [...byMate].flatMap(([to, items]): BundleMatch[] => {
    const acting = items.filter(acts);
    const [first] = acting.length > 0 ? acting : items;
    if (first === undefined || now - first.since < (acting.length > 0 ? t.chase : t.informing))
      return [];
    const last = lastBundle(db, to);
    if (now - last.at < t.chase) return [];
    const due = now - last.informed >= t.informing;
    if (acting.length === 0 && !due) return [];
    return [
      {
        card: first.card,
        lane: to,
        condition: BUNDLE,
        text: bundleText(items),
        tier: last.count + 1,
        fields: { to, watched: due ? items.filter((item) => !acts(item)).length : 0 },
      },
    ];
  });
}
