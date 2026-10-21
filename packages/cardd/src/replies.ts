import type { DatabaseSync } from "node:sqlite";
import { CAPTAIN, howToReply, type Card, type Entry, type OwedReply } from "@fleet/protocol";
import { addEntry, cardEntries, loadCards, workerOf } from "./store.ts";
import type { Timings } from "./timing.ts";

type Recipient = "worker" | "mate";

interface Owed extends OwedReply {
  readonly card: number;
  readonly to: Recipient;
}

const RESENT = "reply-resent";
const MISSED = "reply-missed";

const replyId = (entry: number): string => `r-${String(entry)}`;

function askedIn(entry: Entry): Owed | undefined {
  const owes = entry.fields["owes"];
  const to = entry.fields["for"];
  if (entry.kind !== "comment" || typeof owes !== "string") return undefined;
  if (to !== "worker" && to !== "mate") return undefined;
  return {
    id: replyId(entry.id),
    card: entry.card,
    to,
    from: entry.author.replace(/^mate:/, ""),
    owes,
    text: entry.body,
    askedAt: entry.createdAt,
    resentAt: null,
    escalatedAt: null,
  };
}

const byOwner = (owed: Owed, author: string): boolean =>
  owed.to === "worker" ? author.startsWith("worker:") : author === `mate:${owed.owes}`;

function step(owed: Owed, entry: Entry): Owed | undefined {
  const { fields } = entry;
  if (fields["replyTo"] === owed.id && byOwner(owed, entry.author)) return undefined;
  if (fields["withdraws"] === owed.id && entry.author === `mate:${owed.from}`) return undefined;
  if (fields["reply"] !== owed.id || entry.author !== "check") return owed;
  if (fields["condition"] === RESENT) return { ...owed, resentAt: entry.createdAt };
  return fields["condition"] === MISSED ? { ...owed, escalatedAt: entry.createdAt } : owed;
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

export const openReplies = (entries: readonly Entry[]): OwedReply[] =>
  owedFrom(entries).map(({ id, from, owes, text, askedAt, resentAt, escalatedAt }) => ({
    id,
    from,
    owes,
    text,
    askedAt,
    resentAt,
    escalatedAt,
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
  const { from } = askOn(db, card, id);
  return from === CAPTAIN ? [] : [from];
}

export function isCaptainsReply(db: DatabaseSync, card: Card, id: string): boolean {
  return askOn(db, card, id).from === CAPTAIN;
}

const firstLine = (text: string): string =>
  text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line !== "") ?? "";

function settled(db: DatabaseSync, session: string, now: number, grace: number): boolean {
  const row = db.prepare("SELECT state, last_seen FROM sessions WHERE id = ?").get(session);
  const state = row?.["state"];
  const seen = row?.["last_seen"];
  const quiet = state === "idle" || state === "exited" || state === "lost";
  return quiet && typeof seen === "number" && now - seen >= grace;
}

function missed(
  owed: Owed,
  recipient: string,
  asked: string,
  how: string,
): [string, string, string] {
  if (owed.from === CAPTAIN)
    return [
      MISSED,
      `reply ${owed.id} unanswered: the captain asked on the board, and you got it and one resend, and have not replied: ${asked}. Do it now: ${how}.`,
      recipient,
    ];
  const withdraw = `comment(card=${String(owed.card)}, text, withdraws="${owed.id}")`;
  return [
    MISSED,
    `reply ${owed.id} unanswered: ${owed.owes} got your comment and one resend, and has not replied: ${asked}. Ask again, or withdraw it with ${withdraw}.`,
    owed.from,
  ];
}

function nudge(db: DatabaseSync, owed: Owed, now: number, t: Timings, since: number): string[] {
  const recipient = owed.to === "worker" ? workerOf(db, owed.card) : owed.owes;
  if (now - since < t.reply || recipient === undefined) return [];
  if (!settled(db, recipient, now, t.reply)) return [];
  const asked = `"${firstLine(owed.text)}"`;
  const how = howToReply(owed.to, owed.card, owed.id, owed.from);
  const [condition, body, to] =
    owed.resentAt === null
      ? [
          RESENT,
          `reply ${owed.id} is still owed to ${owed.from}: ${asked}. Please ${how}.`,
          recipient,
        ]
      : missed(owed, recipient, asked, how);
  const fields = { condition, reply: owed.id };
  addEntry(db, { card: owed.card, author: "check", kind: "finding", body, fields }, [to]);
  return [to];
}

export function replyNudges(db: DatabaseSync, now: number, t: Timings): string[] {
  const asking = new Set(
    db
      .prepare(
        "SELECT DISTINCT card FROM entries WHERE kind = 'comment' AND json_extract(fields, '$.owes') IS NOT NULL",
      )
      .all()
      .map((row) => Number(row["card"])),
  );
  const cards = loadCards(db).filter(
    ({ card }) => asking.has(card.id) && card.status !== "done" && card.status !== "dropped",
  );
  return cards.flatMap(({ entries, standing }) => {
    const { hold } = standing.facts;
    const waiting = (owed: Owed): boolean =>
      hold !== undefined && (owed.from !== CAPTAIN || hold.holder === "captain");
    const freed = entries.findLast((entry) => entry.kind === "release" || entry.kind === "answer");
    return owedFrom(entries)
      .filter((owed) => owed.escalatedAt === null && !waiting(owed))
      .flatMap((owed) => {
        const since = Math.max(owed.resentAt ?? owed.askedAt, freed?.createdAt ?? 0);
        return nudge(db, owed, now, t, since);
      });
  });
}
