import type { DatabaseSync } from "node:sqlite";
import { howToReply, type Card, type Entry, type OwedReply } from "@fleet/protocol";
import { factsFrom } from "./status.ts";
import { addEntry, cardEntries, workerOf } from "./store.ts";
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

export function askerOf(db: DatabaseSync, card: Card, id: string): string {
  return askOn(db, card, id).from;
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

function nudge(db: DatabaseSync, owed: Owed, now: number, t: Timings, since: number): string[] {
  const recipient = owed.to === "worker" ? workerOf(db, owed.card) : owed.owes;
  if (now - since < t.reply || recipient === undefined) return [];
  if (!settled(db, recipient, now, t.reply)) return [];
  const asked = `"${firstLine(owed.text)}"`;
  const card = String(owed.card);
  const [condition, body, to] =
    owed.resentAt === null
      ? [
          RESENT,
          `reply ${owed.id} is still owed to ${owed.from}: ${asked}. Please ${howToReply(owed.to, owed.card, owed.id)}.`,
          recipient,
        ]
      : [
          MISSED,
          `reply ${owed.id} unanswered: ${owed.owes} got your comment and one resend, and has not replied: ${asked}. Ask again, or withdraw it with comment(card=${card}, text, withdraws="${owed.id}").`,
          owed.from,
        ];
  const fields = { condition, reply: owed.id };
  addEntry(db, { card: owed.card, author: "check", kind: "finding", body, fields }, [to]);
  return [to];
}

export function replyNudges(db: DatabaseSync, now: number, t: Timings): string[] {
  const cards = db
    .prepare(
      `SELECT DISTINCT e.card AS card FROM entries e JOIN cards c ON c.id = e.card
       WHERE e.kind = 'comment' AND json_extract(e.fields, '$.owes') IS NOT NULL
         AND c.phase NOT IN ('done', 'dropped')`,
    )
    .all();
  return cards.flatMap((row) => {
    const entries = cardEntries(db, Number(row["card"]));
    if (factsFrom(entries).hold !== undefined) return [];
    const freed = entries.findLast((entry) => entry.kind === "release" || entry.kind === "answer");
    return owedFrom(entries)
      .filter((owed) => owed.escalatedAt === null)
      .flatMap((owed) => {
        const since = Math.max(owed.resentAt ?? owed.askedAt, freed?.createdAt ?? 0);
        return nudge(db, owed, now, t, since);
      });
  });
}
