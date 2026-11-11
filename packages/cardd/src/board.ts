import type { DatabaseSync } from "node:sqlite";
import {
  check,
  BoardActionSchema,
  MERGE_OPTIONS,
  OPS,
  type Board,
  type BoardCard,
  type Card,
  type CardView,
  type Entry,
  type Pulse,
  type RemainingStep,
  type Status,
  type Thread,
} from "@fleet/protocol";
import { attemptsOf } from "./attempts.ts";
import { requireOpen, type Draft } from "./change.ts";
import { answerHold, hearers, holdOf, laneOf, rewritten } from "./holds.ts";
import { behindOf, neglectOf, pulseOf, type Neglect } from "./pulse.ts";
import { allSchedules } from "./schedules.ts";
import { openReplies } from "./replies.ts";
import { factsFrom, type Hold } from "./status.ts";
import {
  activityOf,
  addEntry,
  cardEntries,
  getCard,
  isLaneCard,
  loadCard,
  loadCards,
  type Loaded,
} from "./store.ts";
import type { Timings } from "./timing.ts";
import { entryFor } from "./bundle.ts";
import { canSee, datedWait, sightOf } from "./waits.ts";

export class StaleCard extends Error {}

const MATES_ONLY: ReadonlySet<string> = new Set(["job-result", "finding", "review-feedback"]);
const inThread = (entry: Entry): boolean => !MATES_ONLY.has(entry.kind);

const forCaptain = (entry: Entry, laneCard: boolean): boolean =>
  inThread(entry) &&
  (laneCard ||
    entry.fields["for"] === "captain" ||
    !(entry.kind === "comment" && entry.author.startsWith("mate:")));

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

function boardCard(db: DatabaseSync, each: Loaded, neglect: Neglect): BoardCard {
  const { card, entries, standing } = each;
  const { hold } = standing.facts;
  const mate = isLaneCard(db, card);
  const closed = card.status === "done" || card.status === "dropped";
  const replies = closed ? [] : openReplies(entries);
  const wait = datedWait(db, standing);
  return {
    ...card,
    activity: activityOf(db, card, mate),
    summary: summaryOf(card, entries, mate, hold),
    mate,
    holder: hold?.holder ?? null,
    replies,
    attention: standing.attention,
    until: standing.until,
    datedWait: wait,
    pulse: pulseOf(db, each, wait, neglect),
  };
}

const BOARD_TTL = 1000;
const cached = new WeakMap<DatabaseSync, { changes: number; at: number; board: Board }>();

const changesOf = (db: DatabaseSync): number =>
  Number(db.prepare("SELECT total_changes() AS n").get()?.["n"]);

export function boardView(db: DatabaseSync, timing: Timings): Board {
  const now = Date.now();
  const changes = changesOf(db);
  const last = cached.get(db);
  if (last?.changes === changes && now - last.at < BOARD_TTL) return last.board;
  const board = buildBoard(db, now, timing);
  cached.set(db, { changes, at: now, board });
  return board;
}

function buildBoard(db: DatabaseSync, now: number, timing: Timings): Board {
  const holds: Board["holds"] = [];
  const loaded = loadCards(db);
  const statuses = new Map(loaded.map(({ card }) => [card.id, card.status]));
  const neglect = neglectOf(db, timing, now, (id) => statuses.get(id));
  const cards = loaded.map((each) => {
    const card = boardCard(db, each, neglect);
    const { hold } = each.standing.facts;
    const open = card.status !== "done" && card.status !== "dropped";
    if (open && hold?.holder === "captain" && (hold.until === null || hold.until <= now)) {
      const { entry, question, options, merge } = hold;
      holds.push({ card: card.id, hold: entry, question, options: [...options], merge });
    }
    return card;
  });
  return { cards, holds, schedules: allSchedules(db) };
}

export function boardFor(db: DatabaseSync, lane: string, timing: Timings): BoardCard[] {
  return boardView(db, timing)
    .cards.filter((card) => canSee(db, lane, card.lane))
    .map((card) => seenBy(db, lane, card));
}

function stepsSeenBy(db: DatabaseSync, lane: string, card: BoardCard): Pulse | null {
  const { pulse } = card;
  if (pulse === null || card.holder === null) return pulse;
  const remaining = factsFrom(cardEntries(db, card.id)).hold?.remaining ?? [];
  const known = (step: number): Status => {
    const { status, lane: owner } = getCard(db, step);
    return canSee(db, lane, owner) ? status : "queued";
  };
  return { ...pulse, behind: behindOf(remaining, known) };
}

function seenBy(db: DatabaseSync, lane: string, card: BoardCard): BoardCard {
  const datedWait = card.datedWait === null ? null : sightOf(db, lane, card.id, card.datedWait);
  return { ...card, datedWait, pulse: stepsSeenBy(db, lane, card) };
}

function stepOf(db: DatabaseSync, lane: string, id: number): RemainingStep {
  const { title, status, lane: owner } = getCard(db, id);
  return canSee(db, lane, owner) ? { card: id, title, status } : { card: id, elsewhere: true };
}

export function cardView(db: DatabaseSync, id: number, lane: string, timing: Timings): CardView {
  const each = loadCard(db, id);
  const { hold } = each.standing.facts;
  const neglect = neglectOf(db, timing, Date.now(), (step) => getCard(db, step).status);
  return {
    card: seenBy(db, lane, boardCard(db, each, neglect)),
    hold:
      hold === undefined
        ? null
        : {
            holder: hold.holder,
            question: hold.question,
            options: [...hold.options],
            until: hold.until,
            remaining: hold.remaining.map((step) => stepOf(db, lane, step)),
          },
    attempts: attemptsOf(db, id),
    entries: each.entries.flatMap((entry) => entryFor(db, lane, entry) ?? []),
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
  source: "board" | "pane",
): string[] {
  const open = holdOf(db, card);
  if (open?.entry !== hold)
    throw new StaleCard(`that hold on #${String(card.id)} is no longer open`);
  if (open.holder !== "captain")
    throw new Error("that hold is with main or its mate. It reaches you when main escalates it");
  const picked = written && open.merge ? MERGE_OPTIONS[1] : choice;
  const args = { words: choice, source, choice: picked, ...(written ? { written } : {}) };
  return [...answerHold(db, null, card, open, args).notify];
}

function commentOnBoard(db: DatabaseSync, card: Card, text: string): string[] {
  const taken = holdOf(db, card)?.holder === "captain";
  const main = laneOf(db, card, "main") ?? card.lane;
  const to = [main];
  const draft: Draft = {
    card: card.id,
    author: "captain",
    kind: "comment",
    body: text,
    fields: { owes: main, for: "mate", ...(card.lane === main ? {} : { lane: card.lane }) },
  };
  if (taken) requireOpen(db, card);
  addEntry(db, draft, to);
  return to;
}

function deferOnBoard(db: DatabaseSync, card: Card, until: number, reason: string): string[] {
  if (until <= Date.now()) throw new Error("until must be in the future");
  const facts = factsFrom(cardEntries(db, card.id));
  const base = rewritten(facts, facts.hold?.holder ?? "owner", until);
  const fields = { ...base, wait: { by: "later", text: reason }, remaining: [], reason };
  const body = facts.hold?.question ?? reason;
  const draft: Draft = { card: card.id, author: "captain", kind: "hold", body, fields };
  requireOpen(db, card);
  const to = hearers(db, card, null, [fields.holder]);
  addEntry(db, draft, to);
  return to;
}

export function paneAnswer(
  db: DatabaseSync,
  raw: unknown,
): { readonly value: Card; readonly notify: readonly string[] } {
  const { card: id, revision, choice, written } = check(OPS["pane.answer"].args, raw);
  const card = getCard(db, id);
  const open = holdOf(db, card);
  if (card.revision !== revision || open === undefined)
    throw new StaleCard(`c-${String(id)} changed since you looked, so nothing was recorded`);
  const notify = answerOnBoard(db, card, open.entry, choice, written === true, "pane");
  return { value: getCard(db, id), notify };
}

export function boardAction(db: DatabaseSync, raw: unknown): string[] {
  const { card: id, revision, action } = check(BoardActionSchema, raw);
  const card = getCard(db, id);
  if (action.kind !== "comment" && card.revision !== revision)
    throw new StaleCard(`#${String(id)} changed since you looked; here is the current card`);
  if (action.kind === "answer")
    return answerOnBoard(db, card, action.hold, action.choice, action.written === true, "board");
  if (action.kind === "comment") return commentOnBoard(db, card, action.text);
  return deferOnBoard(db, card, action.until, action.reason);
}
