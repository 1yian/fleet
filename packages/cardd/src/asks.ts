// Asks, answers, hand-backs, and holds (spec sections 7.3, 17, and 10.5). An
// ask from a second mate goes to main first (With first mate). Main answers from
// the record, hands it back, or forwards it to the captain.
import type { DatabaseSync } from "node:sqlite";
import { check, OPS, type Card } from "@fleet/protocol";
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
function reachable(db: DatabaseSync, session: Session, id: number): { card: Card; own: boolean } {
  const card = getCard(db, id);
  if (card.lane === session.lane) return { card, own: true };
  if (parentOf(db, card.lane) === session.lane) return { card, own: false };
  throw new Error(`c-${String(id)} belongs to lane ${card.lane}`);
}

/** Whether a captain entry on any card holds these words (a board comment or option click). */
function captainWrote(db: DatabaseSync, words: string): boolean {
  const squashed = words.replace(/\s+/g, " ").trim();
  return (
    db
      .prepare("SELECT 1 FROM entries WHERE author = 'captain' AND instr(body, ?) > 0")
      .get(squashed) !== undefined
  );
}

function openAsk(db: DatabaseSync, card: Card): string {
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
  const { card, own } = reachable(db, session, args.card);
  const resolves = openAsk(db, card);
  if (args.source !== "chat" && !captainWrote(db, args.words)) {
    throw new Error(
      "these words are not in the captain's messages or board entries; quote the captain exactly",
    );
  }
  applyChange(db, card, { kind: "answer" });
  const to = own ? [] : [card.lane];
  const fields = { resolves, source: args.source, by: `mate:${session.lane}` };
  addEntry(db, { card: card.id, author: "captain", kind: "answer", body: args.words, fields }, to);
  return { value: getCard(db, card.id), notify: to };
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
