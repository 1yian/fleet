import { DatabaseSync } from "node:sqlite";
import { CardSchema, check, OPS, type Card, type Holder } from "@fleet/protocol";
import { Cardd, type Session } from "./cardd.ts";

export interface Fleet {
  readonly cardd: Cardd;
  readonly mainToken: string;
  readonly main: Session;
}

export async function startFleet(env: Record<string, string> = {}): Promise<Fleet> {
  const cardd = await Cardd.start(env);
  const mainToken = cardd.addLane("main");
  cardd.addProject("web", { maverick: "/clones/web", p620: "/clones/web" }, "acme/web");
  return { cardd, mainToken, main: await cardd.connect(mainToken) };
}

export async function newCard(
  mate: Session,
  title: string,
  kind: Card["kind"] = "ship",
): Promise<Card> {
  return check(CardSchema, await mate.call("card.new", { title, kind, project: "web" }));
}

const WORKER_HOST = "maverick";

export async function begin(
  mate: Session,
  card: Card,
  task = "the task",
  host = WORKER_HOST,
): Promise<string> {
  const value = await mate.call("attempt.begin", { card: card.id, host, task });
  return check(OPS["attempt.begin"].result, value).token;
}

export async function status(mate: Session, card: Card): Promise<Card["status"]> {
  const cards = check(OPS.board.result, await mate.call("board", {}));
  const found = cards.find((each) => each.id === card.id);
  if (found === undefined) throw new Error(`card ${String(card.id)} is not on the board`);
  return found.status;
}

export const OUTSIDE_DATE = { outside: "a fixed date that needs no checking", remaining: [] };

export function oldDatedHold(
  cardd: Cardd,
  card: Card,
  holder: Holder,
  opened: number,
  until: number,
  remaining: readonly number[] = [],
): void {
  const db = new DatabaseSync(cardd.db, { timeout: 5000 });
  try {
    const author = holder === "captain" ? "mate:main" : "mate:cleo";
    const fields = { holder, options: [], merge: false, until, occurrence: 1, remaining };
    db.prepare(
      "INSERT INTO entries (card, author, kind, body, fields, created_at) VALUES (?, ?, 'hold', 'Wait for it?', ?, ?)",
    ).run(card.id, author, JSON.stringify(fields), opened);
  } finally {
    db.close();
  }
}

function insertEntry(
  cardd: Cardd,
  card: Card,
  author: string,
  kind: string,
  body: string,
  fields: Record<string, unknown>,
): void {
  const db = new DatabaseSync(cardd.db, { timeout: 5000 });
  try {
    db.prepare(
      "INSERT INTO entries (card, author, kind, body, fields, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(card.id, author, kind, body, JSON.stringify(fields), Date.now());
  } finally {
    db.close();
  }
}

export function oldMergeHold(cardd: Cardd, card: Card, options: readonly string[]): void {
  const fields = { holder: "captain", options, merge: true, until: null, occurrence: 1 };
  insertEntry(cardd, card, "mate:main", "hold", "Merge it?", fields);
}

export function oldApproval(cardd: Cardd, card: Card): void {
  const fields = { occurrence: 1, source: "board", by: "board", choice: "Approve & merge" };
  insertEntry(cardd, card, "captain", "answer", "Approve & merge", fields);
}

export const park = (
  mate: Session,
  card: Card,
  question: string,
  ms: number,
  more: Record<string, unknown> = OUTSIDE_DATE,
): Promise<unknown> =>
  mate.call("hold", { card: card.id, question, until: Date.now() + ms, ...more });

export function ageCards(cardd: Cardd, cards: readonly Card[], ms: number): void {
  const ids = cards.map(({ id }) => id);
  const marks = ids.map(() => "?").join(", ");
  const db = new DatabaseSync(cardd.db, { timeout: 5000 });
  try {
    db.exec("DROP TRIGGER IF EXISTS entries_no_update");
    db.exec("BEGIN IMMEDIATE");
    db.prepare(`UPDATE entries SET created_at = created_at - ? WHERE card IN (${marks})`).run(
      ms,
      ...ids,
    );
    db.prepare(`UPDATE cards SET created_at = created_at - ? WHERE id IN (${marks})`).run(
      ms,
      ...ids,
    );
    db.exec("COMMIT");
  } finally {
    db.close();
  }
}

export const ageCard = (cardd: Cardd, card: Card, ms: number): void => {
  ageCards(cardd, [card], ms);
};

export function ageSession(cardd: Cardd, card: Card, ms: number): void {
  const db = new DatabaseSync(cardd.db, { timeout: 5000 });
  try {
    db.prepare(
      `UPDATE sessions SET last_seen = last_seen - ?
       WHERE attempt IN (SELECT id FROM attempts WHERE card = ?)`,
    ).run(ms, card.id);
  } finally {
    db.close();
  }
}
