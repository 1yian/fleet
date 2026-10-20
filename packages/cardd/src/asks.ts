// Asks, answers, hand-backs, and holds (spec sections 7.3, 17, and 10.5). An
// ask from a second mate goes to main first (With first mate). Main answers from
// the record, hands it back, or forwards it to the captain.
import type { DatabaseSync } from "node:sqlite";
import { check, MERGE_OPTIONS, OPS, type Card } from "@fleet/protocol";
import { requireCaptainWords } from "./authority.ts";
import { applyChange } from "./change.ts";
import { factsFrom } from "./status.ts";
import { addEntry, cardEntries, getCard, type Session } from "./store.ts";

interface Done {
  readonly value: unknown;
  readonly notify: readonly string[];
}

function parentOf(db: DatabaseSync, lane: string): string | null {
  const parent = db.prepare("SELECT parent FROM lanes WHERE name = ?").get(lane)?.["parent"];
  return typeof parent === "string" ? parent : null;
}

/** The card, if the session's lane owns it or is the parent of the lane that does. */
export function reachable(
  db: DatabaseSync,
  session: Session,
  id: number,
): { card: Card; own: boolean } {
  const card = getCard(db, id);
  if (card.lane === session.lane) return { card, own: true };
  if (parentOf(db, card.lane) === session.lane) return { card, own: false };
  throw new Error(`c-${String(id)} belongs to lane ${card.lane}`);
}

export function openAsk(db: DatabaseSync, card: Card): string {
  const ask = factsFrom(cardEntries(db, card.id)).askIds.at(-1);
  if (ask === undefined) throw new Error(`c-${String(card.id)} has no open question`);
  return ask;
}

export function ask(db: DatabaseSync, session: Session, raw: unknown): Done {
  const args = check(OPS.ask.args, raw);
  const { card, own } = reachable(db, session, args.card);
  if (!own && card.status !== "with-first-mate") {
    throw new Error(
      `main can forward only a question that is With first mate; c-${String(card.id)} is ${card.status}`,
    );
  }
  const parent = parentOf(db, card.lane);
  const toFirstMate = own && parent !== null;
  applyChange(db, card, { kind: "ask", toFirstMate });
  const to = toFirstMate ? [parent] : [];
  // A forward replaces the second mate's question, so the captain answers one question.
  const fields = { options: args.options, ...(own ? {} : { resolves: openAsk(db, card) }) };
  addEntry(
    db,
    { card: card.id, author: `mate:${session.lane}`, kind: "ask", body: args.question, fields },
    to,
  );
  return { value: getCard(db, card.id), notify: to };
}

export function answer(db: DatabaseSync, session: Session, raw: unknown): Done {
  const args = check(OPS.answer.args, raw);
  const { card } = reachable(db, session, args.card);
  const resolves = openAsk(db, card);
  requireCaptainWords(db, args.words, args.source);
  return recordAnswer(db, session, card, resolves, args);
}

/** Closes an open question with the captain's verified words. Returns the sessions to notify. */
export function recordAnswer(
  db: DatabaseSync,
  session: Session,
  card: Card,
  resolves: string,
  args: { readonly words: string; readonly source: string; readonly choice?: string | undefined },
): Done {
  const merge = mergeChoice(db, card, resolves, args.choice);
  applyChange(db, card, merge === undefined ? { kind: "answer" } : { kind: "answer", merge });
  const to = card.lane === session.lane ? [] : [card.lane];
  const fields = { resolves, source: args.source, by: `mate:${session.lane}`, choice: args.choice };
  addEntry(db, { card: card.id, author: "captain", kind: "answer", body: args.words, fields }, to);
  return { value: getCard(db, card.id), notify: to };
}

/** The card's latest open merge question. */
export function openMergeAsk(db: DatabaseSync, card: Card): string | undefined {
  const entries = cardEntries(db, card.id);
  const merges = new Set(
    entries.filter((entry) => entry.fields["merge"] === true).map((entry) => String(entry.id)),
  );
  return factsFrom(entries).askIds.findLast((id) => merges.has(id));
}

/** For a merge question, the captain's choice: approve or request changes. Undefined for other questions. */
export function mergeChoice(
  db: DatabaseSync,
  card: Card,
  askId: string,
  choice: string | undefined,
): "approve" | "changes" | undefined {
  const ask = cardEntries(db, card.id).find((entry) => String(entry.id) === askId);
  if (ask?.fields["merge"] !== true) return undefined;
  const [approve, changes] = MERGE_OPTIONS;
  if (choice === approve) return "approve";
  if (choice === changes) return "changes";
  throw new Error(`a merge question needs the choice "${approve}" or "${changes}"`);
}

export function handback(db: DatabaseSync, session: Session, raw: unknown): Done {
  const args = check(OPS.handback.args, raw);
  const { card, own } = reachable(db, session, args.card);
  if (own || card.status !== "with-first-mate") {
    throw new Error(`only main can hand back, and only a question that is With first mate`);
  }
  const resolves = openAsk(db, card);
  applyChange(db, card, { kind: "handback" });
  const fields = { resolves, handback: true };
  addEntry(
    db,
    { card: card.id, author: `mate:${session.lane}`, kind: "note", body: args.guidance, fields },
    [card.lane],
  );
  return { value: getCard(db, card.id), notify: [card.lane] };
}

export function hold(db: DatabaseSync, session: Session, raw: unknown): Done {
  const args = check(OPS.hold.args, raw);
  const { card, own } = reachable(db, session, args.card);
  if (!own) throw new Error(`c-${String(card.id)} belongs to lane ${card.lane}`);
  if (args.until <= Date.now()) throw new Error("until must be in the future");
  if (card.status === "waiting") throw new Error(`c-${String(card.id)} is already waiting`);
  db.prepare("UPDATE cards SET held_until = ?, return_status = ? WHERE id = ?").run(
    args.until,
    card.status,
    card.id,
  );
  applyChange(db, card, { kind: "hold" });
  const body = `held until ${new Date(args.until).toISOString()}: ${args.reason}`;
  addEntry(
    db,
    {
      card: card.id,
      author: `mate:${session.lane}`,
      kind: "status",
      body,
      fields: { until: args.until },
    },
    [],
  );
  return { value: getCard(db, card.id), notify: [] };
}
