import type { DatabaseSync } from "node:sqlite";
import {
  check,
  BoardActionSchema,
  MERGE_OPTIONS,
  type Board,
  type BoardCard,
  type Card,
  type CardView,
  type Entry,
  type Thread,
} from "@fleet/protocol";
import { attemptsOf } from "./attempts.ts";
import { requireOpen, type Draft } from "./change.ts";
import { answerHold, hearers, holdOf, rewritten } from "./holds.ts";
import { openReplies } from "./replies.ts";
import { factsFrom, type Hold } from "./status.ts";
import {
  addEntry,
  cardEntries,
  getCard,
  isLaneCard,
  loadCard,
  loadCards,
  type Loaded,
} from "./store.ts";

export class StaleCard extends Error {}

const MATES_ONLY: ReadonlySet<string> = new Set(["job-result", "finding", "review-feedback"]);
const inThread = (entry: Entry): boolean => !MATES_ONLY.has(entry.kind);

const forCaptain = (entry: Entry, laneCard: boolean): boolean =>
  inThread(entry) && (laneCard || !(entry.kind === "comment" && entry.author.startsWith("mate:")));

const firstLine = (text: string): string =>
  text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line !== "") ?? "";

function summaryOf(card: Card, entries: readonly Entry[], laneCard: boolean, hold?: Hold): string {
  const withMain = hold?.holder === "main" ? hold.entry : undefined;
  const latest = entries.findLast(
    (entry) =>
      forCaptain(entry, laneCard) &&
      (entry.kind !== "hold" || entry.id === withMain) &&
      entry.fields["routed"] !== true,
  );
  if (latest !== undefined && latest.id === withMain) return `Asks main: ${firstLine(latest.body)}`;
  return firstLine(latest?.body ?? card.intent);
}

function boardCard(db: DatabaseSync, { card, entries, standing }: Loaded): BoardCard {
  const { hold } = standing.facts;
  const mate = isLaneCard(db, card);
  const closed = card.status === "done" || card.status === "dropped";
  const replies = closed ? [] : openReplies(entries);
  return {
    ...card,
    summary: summaryOf(card, entries, mate, hold),
    mate,
    holder: hold?.holder ?? null,
    replies,
    attention: standing.attention,
    pausedUntil: standing.pausedUntil,
  };
}

export function boardView(db: DatabaseSync): Board {
  const now = Date.now();
  const holds: Board["holds"] = [];
  const cards = loadCards(db).map((each) => {
    const card = boardCard(db, each);
    const { hold } = each.standing.facts;
    const open = card.status !== "done" && card.status !== "dropped";
    if (open && hold?.holder === "captain" && (hold.until === null || hold.until <= now)) {
      const { entry, question, options, merge } = hold;
      holds.push({ card: card.id, hold: entry, question, options: [...options], merge });
    }
    return card;
  });
  return { cards, holds };
}

export function cardView(db: DatabaseSync, id: number): CardView {
  const each = loadCard(db, id);
  const { hold } = each.standing.facts;
  return {
    card: boardCard(db, each),
    hold:
      hold === undefined
        ? null
        : {
            holder: hold.holder,
            question: hold.question,
            options: [...hold.options],
            until: hold.until,
          },
    attempts: attemptsOf(db, id),
    entries: each.entries,
  };
}

export const thread = (db: DatabaseSync, id: number): Thread => ({
  card: getCard(db, id),
  entries: cardEntries(db, id).filter(inThread),
});

function answerOnBoard(
  db: DatabaseSync,
  card: Card,
  hold: number,
  choice: string,
  written: boolean,
): string[] {
  const open = holdOf(db, card);
  if (open?.entry !== hold)
    throw new StaleCard(`that hold on c-${String(card.id)} is no longer open`);
  if (open.holder !== "captain")
    throw new Error("that hold is with main or its mate. It reaches you when main escalates it");
  const picked = written && open.merge ? MERGE_OPTIONS[1] : choice;
  const args = { words: choice, source: "board", choice: picked, ...(written ? { written } : {}) };
  return [...answerHold(db, null, card, open, args).notify];
}

function commentOnBoard(db: DatabaseSync, card: Card, text: string): string[] {
  const taken = holdOf(db, card)?.holder === "captain";
  const to = taken ? hearers(db, card, null, ["main"]) : [card.lane];
  const draft: Draft = {
    card: card.id,
    author: "captain",
    kind: "comment",
    body: text,
    fields: {},
  };
  if (taken) requireOpen(db, card);
  addEntry(db, draft, to);
  return to;
}

function deferOnBoard(db: DatabaseSync, card: Card, until: number, reason: string): string[] {
  if (until <= Date.now()) throw new Error("until must be in the future");
  const facts = factsFrom(cardEntries(db, card.id));
  const fields = { ...rewritten(facts, facts.hold?.holder ?? "owner", until), reason };
  const body = facts.hold?.question ?? reason;
  const draft: Draft = { card: card.id, author: "captain", kind: "hold", body, fields };
  requireOpen(db, card);
  const to = hearers(db, card, null, [fields.holder]);
  addEntry(db, draft, to);
  return to;
}

export function boardAction(db: DatabaseSync, raw: unknown): string[] {
  const { card: id, revision, action } = check(BoardActionSchema, raw);
  const card = getCard(db, id);
  if (action.kind !== "comment" && card.revision !== revision)
    throw new StaleCard(`c-${String(id)} changed since you looked; here is the current card`);
  if (action.kind === "answer")
    return answerOnBoard(db, card, action.hold, action.choice, action.written === true);
  if (action.kind === "comment") return commentOnBoard(db, card, action.text);
  return deferOnBoard(db, card, action.until, action.reason);
}
