import type { DatabaseSync } from "node:sqlite";
import {
  CAPTAIN,
  howToAnswerWake,
  howToReply,
  type Card,
  type Entry,
  type OwedReply,
} from "@fleet/protocol";
import { cardEntries, workerOf, type Loaded } from "./store.ts";
import { remind } from "./deliveries.ts";
import type { Timings } from "./timing.ts";

type Recipient = "worker" | "mate";

interface Owed extends OwedReply {
  readonly card: number;
  readonly to: Recipient;
  readonly scheduled: boolean;
}

const RESENT = "reply-resent";

const replyId = (entry: number): string => `r-${String(entry)}`;

const field = (entry: Entry, key: string): string | undefined => {
  const value = entry.fields[key];
  return typeof value === "string" ? value : undefined;
};

function askedIn(entry: Entry): Owed | undefined {
  const owes = entry.fields["owes"];
  const to = entry.fields["for"];
  if (entry.kind !== "comment" || typeof owes !== "string") return undefined;
  if (to !== "worker" && to !== "mate") return undefined;
  return {
    id: replyId(entry.id),
    card: entry.card,
    to,
    scheduled: entry.fields["wake"] === "scheduled",
    from: field(entry, "from") ?? entry.author.replace(/^mate:/, ""),
    owes,
    text: entry.body,
    askedAt: entry.createdAt,
    resentAt: null,
  };
}

const byOwner = (owed: Owed, author: string): boolean =>
  owed.to === "worker" ? author.startsWith("worker:") : author === `mate:${owed.owes}`;

function step(owed: Owed, entry: Entry): Owed | undefined {
  const { fields } = entry;
  if (fields["replyTo"] === owed.id && byOwner(owed, entry.author)) return undefined;
  if (fields["withdraws"] === owed.id && entry.author === `mate:${owed.from}`) return undefined;
  if (fields["reply"] !== owed.id || entry.author !== "check") return owed;
  return fields["condition"] === RESENT ? { ...owed, resentAt: entry.createdAt } : owed;
}

function owedFrom(entries: readonly Entry[]): Owed[] {
  let open: Owed[] = [];
  for (const entry of entries) {
    open = open.flatMap((owed) => step(owed, entry) ?? []);
    const asked = askedIn(entry);
    if (asked !== undefined) open.push(asked);
  }
  return open;
}

export const workerOwedIds = (entries: readonly Entry[]): string[] =>
  owedFrom(entries)
    .filter((owed) => owed.to === "worker")
    .map((owed) => owed.id);

export const openReplies = (entries: readonly Entry[]): OwedReply[] =>
  owedFrom(entries).map(({ id, from, owes, text, askedAt, resentAt }) => ({
    id,
    from,
    owes,
    text,
    askedAt,
    resentAt,
  }));

function askOn(db: DatabaseSync, card: Card, id: string): Owed {
  const entry = Number(id.slice(2));
  const asked = cardEntries(db, card.id)
    .filter((each) => each.id === entry)
    .map(askedIn)
    .find((each) => each !== undefined);
  if (asked !== undefined) return asked;
  const elsewhere = db.prepare("SELECT card FROM entries WHERE id = ?").get(entry)?.["card"];
  const hint = typeof elsewhere === "number" ? `: it is on c-${String(elsewhere)}` : "";
  throw new Error(`${id} is not a reply asked on c-${String(card.id)}${hint}`);
}

export function requireOwedBy(db: DatabaseSync, card: Card, id: string, author: string): void {
  const asked = askOn(db, card, id);
  if (!byOwner(asked, author))
    throw new Error(`${id} is owed by ${asked.owes}, so only it can answer`);
}

export function requireAskedBy(db: DatabaseSync, card: Card, id: string, lane: string): void {
  const asked = askOn(db, card, id);
  if (asked.from !== lane)
    throw new Error(`${id} was asked by ${asked.from}, so only it can withdraw it`);
}

export function askersOf(db: DatabaseSync, card: Card, id: string): string[] {
  const { from, scheduled } = askOn(db, card, id);
  return from === CAPTAIN || scheduled ? [] : [from];
}

export function isCaptainsReply(db: DatabaseSync, card: Card, id: string): boolean {
  return askOn(db, card, id).from === CAPTAIN;
}

const firstLine = (text: string): string =>
  text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line !== "") ?? "";

const up = (db: DatabaseSync, session: string): boolean =>
  db
    .prepare("SELECT 1 FROM sessions WHERE id = ? AND state IN ('idle', 'running', 'waiting')")
    .get(session) !== undefined;

function nudge(db: DatabaseSync, owed: Owed, now: number, t: Timings, since: number): string[] {
  const recipient = owed.to === "worker" ? workerOf(db, owed.card) : owed.owes;
  const wait = owed.resentAt === null ? t.reply : t.repeat;
  if (now - since < wait || recipient === undefined) return [];
  if (!up(db, recipient)) return [];
  const asked = `"${firstLine(owed.text)}"`;
  const how = owed.scheduled
    ? howToAnswerWake(owed.card, owed.id)
    : howToReply(owed.to, owed.card, owed.id, owed.from);
  const body = `reply ${owed.id} is still owed to ${owed.from}: ${asked}. Please ${how}.`;
  const fields = { condition: RESENT, reply: owed.id };
  remind(
    db,
    { card: owed.card, author: "check", kind: "finding", body, fields },
    [recipient],
    owed.id,
  );
  return [recipient];
}

export function replyNudges(
  db: DatabaseSync,
  open: readonly Loaded[],
  now: number,
  t: Timings,
): string[] {
  return open.flatMap(({ entries, standing }) => {
    const { hold } = standing.facts;
    if (hold?.until !== null && hold?.until !== undefined && hold.until > now) return [];
    const freed = entries.findLast((entry) => entry.kind === "release" || entry.kind === "answer");
    return owedFrom(entries).flatMap((owed) => {
      const since = Math.max(owed.resentAt ?? owed.askedAt, freed?.createdAt ?? 0);
      return nudge(db, owed, now, t, since);
    });
  });
}
