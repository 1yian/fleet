import type { DatabaseSync } from "node:sqlite";
import {
  check,
  isScheduleLog,
  SCHEDULE_LOG_NAME,
  BoardActionSchema,
  type Board,
  type BoardCard,
  type Card,
  type CardView,
  type Entry,
  type LaterResult,
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
import { factsFrom, holdDeferred, type Hold } from "./status.ts";
import {
  activityOf,
  addEntry,
  cardEntries,
  getCard,
  isLaneCard,
  loadCard,
  loadCards,
  mainLane,
  type Loaded,
} from "./store.ts";
import type { Timings } from "./timing.ts";
import { entryFor } from "./bundle.ts";
import { canSee, datedWait, sightOf } from "./waits.ts";
import { laterAt } from "./later.ts";
import { reviewDecision, reviewPreview } from "./review-completion.ts";

export class StaleCard extends Error {}

const askingCaptain = (hold: Hold, now: number): boolean =>
  hold.holder === "captain" && !holdDeferred(hold, now);

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((each, at) => each === b[at]);

const sameHold = (a: Hold, b: Hold): boolean =>
  a.occurrence === b.occurrence &&
  a.holder === b.holder &&
  a.question === b.question &&
  a.merge === b.merge &&
  a.originalMerge === b.originalMerge &&
  sameList(a.options, b.options) &&
  sameList(a.approves, b.approves);

function requireSeen(db: DatabaseSync, card: Card, seen: number): Hold {
  const entries = cardEntries(db, card.id);
  const open = factsFrom(entries).hold;
  const name = `c-${String(card.id)}`;
  if (open === undefined || holdDeferred(open, Date.now()))
    throw new StaleCard(`${name} is no longer waiting for your answer, so nothing was recorded`);
  if (open.reviewRequests !== undefined) {
    if (open.entry === seen && reviewDecision(entries, open)) return open;
  } else {
    const upToSeen = entries.slice(0, entries.findIndex((entry) => entry.id === seen) + 1);
    const shown = factsFrom(upToSeen).hold;
    if (shown !== undefined && sameHold(open, shown)) return open;
  }
  throw new StaleCard(`${name}'s decision changed, so nothing was recorded`);
}

function requireCaptainsHold(db: DatabaseSync, card: Card, seen: number): Hold {
  const open = requireSeen(db, card, seen);
  if (open.holder !== "captain")
    throw new Error("that hold is with main or its mate. It reaches you when main escalates it");
  return open;
}

const MATES_ONLY: ReadonlySet<string> = new Set(["job-result", "finding", "review-feedback"]);
const inThread = (entry: Entry): boolean =>
  !MATES_ONLY.has(entry.kind) && entry.fields["maintenance"] !== "batch";

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

function evidencePaths(entries: readonly Entry[]): string[] {
  return entries.flatMap((entry) => {
    const path = entry.fields["evidence"];
    return typeof path === "string" ? [path] : [];
  });
}

const withoutPaths = (text: string, paths: readonly string[]): string =>
  paths.reduce((shown, path) => shown.replaceAll(path, "the evidence report"), text);

function summaryOf(card: Card, entries: readonly Entry[], laneCard: boolean, hold?: Hold): string {
  const withMain = hold?.holder === "main" ? hold.entry : undefined;
  const latest = entries.findLast(
    (entry) =>
      forCaptain(entry, laneCard) &&
      (entry.kind !== "hold" || entry.id === withMain) &&
      entry.fields["routed"] !== true,
  );
  const paths = evidencePaths(entries);
  if (latest !== undefined && latest.id === withMain)
    return `Asks main: ${firstLine(withoutPaths(latest.body, paths))}`;
  return firstLine(withoutPaths(latest?.body ?? card.intent, paths));
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
    scheduleLog:
      card.kind === "standing" && card.name === SCHEDULE_LOG_NAME && card.lane === mainLane(db),
    holder: hold?.holder ?? null,
    replies,
    attention: standing.attention,
    until: standing.until,
    datedWait: wait,
    pulse: pulseOf(db, each, wait, neglect),
  };
}

const BOARD_TTL = 1000;
const cached = new WeakMap<
  DatabaseSync,
  { changes: number; at: number; origins: ReadonlyMap<string, string> | undefined; board: Board }
>();

const changesOf = (db: DatabaseSync): number =>
  Number(db.prepare("SELECT total_changes() AS n").get()?.["n"]);

export function boardView(
  db: DatabaseSync,
  timing: Timings,
  origins?: ReadonlyMap<string, string>,
): Board {
  const now = Date.now();
  const changes = changesOf(db);
  const last = cached.get(db);
  if (last?.changes === changes && last.origins === origins && now - last.at < BOARD_TTL)
    return last.board;
  const board = buildBoard(db, now, timing, origins);
  cached.set(db, { changes, at: now, origins, board });
  return board;
}

function buildBoard(
  db: DatabaseSync,
  now: number,
  timing: Timings,
  origins: ReadonlyMap<string, string> | undefined,
): Board {
  const holds: Board["holds"] = [];
  const loaded = loadCards(db);
  const statuses = new Map(loaded.map(({ card }) => [card.id, card.status]));
  const neglect = neglectOf(db, timing, now, (id) => statuses.get(id));
  const cards = loaded.map((each) => {
    const card = boardCard(db, each, neglect);
    const { hold } = each.standing.facts;
    const open = card.status !== "done" && card.status !== "dropped";
    if (open && !isScheduleLog(card) && hold !== undefined && askingCaptain(hold, now)) {
      const { question, options, merge, originalMerge, author } = hold;
      if (hold.reviewRequests !== undefined && !reviewDecision(each.entries, hold)) return card;
      const preview = origins === undefined ? undefined : reviewPreview(hold, origins, now);
      holds.push({
        card: card.id,
        hold: hold.entry,
        question,
        options: [...options],
        merge,
        originalMerge,
        author,
        ...(preview === undefined ? {} : { review: true }),
      });
    }
    return card;
  });
  return { cards, holds, schedules: allSchedules(db) };
}

export function boardFor(db: DatabaseSync, lane: string, timing: Timings): BoardCard[] {
  return boardView(db, timing)
    .cards.filter((card) => !isScheduleLog(card) && canSee(db, lane, card.lane))
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
            entry: hold.entry,
            holder: hold.holder,
            question: hold.question,
            options: [...hold.options],
            merge: hold.merge,
            approves: [...hold.approves],
            until: hold.until,
            remaining: hold.remaining.map((step) => stepOf(db, lane, step)),
          },
    attempts: attemptsOf(db, id),
    entries: each.entries
      .flatMap((entry) => entryFor(db, lane, entry) ?? [])
      .map((entry) => ({ ...entry, body: withoutPaths(entry.body, evidencePaths(each.entries)) })),
  };
}

export function thread(db: DatabaseSync, id: number): Thread {
  const entries = cardEntries(db, id);
  const paths = evidencePaths(entries);
  return {
    card: getCard(db, id),
    entries: entries.filter(inThread).map((entry) => ({
      ...entry,
      body: withoutPaths(entry.body, paths),
      fields: Object.fromEntries(
        Object.entries(entry.fields).filter(([key]) => key !== "evidence"),
      ),
    })),
  };
}

function answerOnBoard(
  db: DatabaseSync,
  card: Card,
  hold: number,
  choice: string,
  written: boolean,
): string[] {
  const open = requireCaptainsHold(db, card, hold);
  const args = { words: choice, source: "board", choice, ...(written ? { written } : {}) };
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

interface Deferred extends LaterResult {
  readonly notify: string[];
}

function deferOnBoard(
  db: DatabaseSync,
  card: Card,
  hold: number,
  said: string,
  zone: string,
  now: number,
): Deferred {
  requireCaptainsHold(db, card, hold);
  const later = laterAt(said, now, zone);
  const facts = factsFrom(cardEntries(db, card.id));
  const base = rewritten(facts, facts.hold?.holder ?? "owner", later.until);
  const fields = { ...base, wait: { by: "later", text: said.trim() }, remaining: [] };
  const body = facts.hold?.question ?? `The captain put this off: ${said.trim()}`;
  const draft: Draft = { card: card.id, author: "captain", kind: "hold", body, fields };
  requireOpen(db, card);
  const notify = hearers(db, card, null, ["main"]);
  addEntry(db, draft, notify);
  return { notify, ...later };
}

export function boardAction(
  db: DatabaseSync,
  raw: unknown,
  now: number,
): { readonly notify: string[]; readonly later?: LaterResult } {
  const { card: id, action } = check(BoardActionSchema, raw);
  const card = getCard(db, id);
  if (action.kind === "answer") {
    const written = action.written === true;
    return { notify: answerOnBoard(db, card, action.hold, action.choice, written) };
  }
  if (action.kind === "comment") return { notify: commentOnBoard(db, card, action.text) };
  const { notify, until, zone } = deferOnBoard(
    db,
    card,
    action.hold,
    action.said,
    action.zone,
    now,
  );
  return { notify, later: { until, zone } };
}
