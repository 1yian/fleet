import type { DatabaseSync } from "node:sqlite";
import { CAPTAIN_LOG_NAME, type Entry, type OpArgs, type OpResult } from "@fleet/protocol";
import { addEntry, loadCard, loadOpenCards, mainLane, type Loaded, type Session } from "./store.ts";
import { logCardOf } from "./log-cards.ts";
import { firstLine } from "./text.ts";

const SEEN = "captain.seen";
const AWAY = "captain.away";
const PRESENTED = "presented";

export const isMark = (entry: Entry): boolean =>
  entry.kind === "note" && typeof entry.fields["mark"] === "string";

function requireMain(db: DatabaseSync, session: Session): void {
  if (session.lane !== mainLane(db))
    throw new Error("only main records what the captain has been told");
}

const author = (session: Session): string => `mate:${session.lane}`;

export function recordSeen(
  db: DatabaseSync,
  session: Session,
  args: OpArgs<"captain.seen">,
): OpResult<"captain.seen"> {
  requireMain(db, session);
  const away = args.away === true;
  const entry = addEntry(
    db,
    {
      card: logCardOf(db, session.lane, CAPTAIN_LOG_NAME, "Captain activity"),
      author: author(session),
      kind: "note",
      body: away ? "the captain said afk" : "the captain wrote in chat",
      fields: { mark: away ? AWAY : SEEN },
    },
    [],
  );
  return { entry };
}

interface Captain {
  readonly entry: number;
  readonly away: boolean;
}

function lastCaptainMark(db: DatabaseSync): Captain | undefined {
  const row = db
    .prepare(
      `SELECT json_extract(e.fields, '$.mark') AS mark, e.id AS entry
       FROM entries e JOIN cards c ON c.id = e.card
       WHERE c.lane = ? AND c.kind = 'standing' AND c.name = ? AND e.kind = 'note'
       ORDER BY e.id DESC LIMIT 1`,
    )
    .get(mainLane(db), CAPTAIN_LOG_NAME);
  if (row === undefined) return undefined;
  if (typeof row["entry"] !== "number" || (row["mark"] !== SEEN && row["mark"] !== AWAY))
    throw new Error("invalid captain activity mark");
  return { entry: row["entry"], away: row["mark"] === AWAY };
}

const captainDecisions = (cards: readonly Loaded[]): Loaded[] =>
  cards.filter(({ standing }) => standing.status === "needs-you");

function presentation({ entries, standing }: Loaded): number | undefined {
  const occurrence = standing.facts.hold?.occurrence;
  return entries.findLast(
    (entry) =>
      entry.kind === "note" &&
      entry.fields["mark"] === PRESENTED &&
      entry.fields["occurrence"] === occurrence,
  )?.id;
}

export interface Rotation {
  readonly due: Loaded | undefined;
  readonly shown: ReadonlySet<number>;
  readonly waiting: number;
}

function presentedSince(db: DatabaseSync, entry: number): boolean {
  return (
    db
      .prepare(
        `SELECT 1 FROM entries WHERE id > ? AND author = ? AND kind = 'note'
       AND json_extract(fields, '$.mark') = 'presented' LIMIT 1`,
      )
      .get(entry, `mate:${mainLane(db)}`) !== undefined
  );
}

export function rotationOf(db: DatabaseSync, cards: readonly Loaded[]): Rotation {
  const decisions = captainDecisions(cards);
  if (decisions.length === 0) return { due: undefined, shown: new Set(), waiting: 0 };
  const seen = lastCaptainMark(db);
  const marked = decisions.map((each) => ({ each, at: presentation(each) }));
  const since = seen?.entry ?? Infinity;
  const shown = new Set(
    marked.filter(({ at }) => at !== undefined && at >= since).map(({ each }) => each.card.id),
  );
  const open = seen !== undefined && !seen.away && !presentedSince(db, seen.entry);
  const never = marked.filter(({ at }) => at === undefined);
  const pool = never.length > 0 ? never : marked;
  const [first] = open
    ? [...pool].sort(
        (a, b) =>
          (a.at ?? 0) - (b.at ?? 0) ||
          a.each.standing.since - b.each.standing.since ||
          a.each.card.id - b.each.card.id,
      )
    : [];
  return { due: first?.each, shown, waiting: Math.max(decisions.length - 1, 0) };
}

export function recordPresented(
  db: DatabaseSync,
  session: Session,
  args: OpArgs<"presented">,
): OpResult<"presented"> {
  requireMain(db, session);
  const { card, standing } = loadCard(db, args.card);
  const { hold } = standing.facts;
  if (standing.status !== "needs-you" || hold === undefined)
    throw new Error(
      `c-${String(card.id)} is not waiting on the captain, so nothing was recorded. Only a decision that waits on him is brought up`,
    );
  if (hold.occurrence !== args.occurrence)
    throw new Error(
      `c-${String(card.id)} was held again since you checked it, so nothing was recorded. Check the card and bring up its current question`,
    );
  addEntry(
    db,
    {
      card: card.id,
      author: author(session),
      kind: "note",
      body: "brought up to the captain in chat",
      fields: { mark: PRESENTED, hold: hold.entry, occurrence: hold.occurrence },
    },
    [],
  );
  const decisions = captainDecisions(loadOpenCards(db));
  return { card: card.id, waiting: Math.max(decisions.length - 1, 0) };
}

export function dueDecision(db: DatabaseSync, session: Session): OpResult<"decision.due"> {
  requireMain(db, session);
  const { due, waiting } = rotationOf(db, loadOpenCards(db));
  if (due === undefined) return null;
  const question = firstLine(due.standing.facts.hold?.question ?? "");
  return { card: due.card.id, title: due.card.title, question, waiting };
}
