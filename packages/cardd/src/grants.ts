// grant (spec section 18): a recorded permission, set only with the captain's words.
import type { DatabaseSync } from "node:sqlite";
import { check, OPS, type Card } from "@fleet/protocol";
import { requireCaptainWords } from "./authority.ts";
import { addEntry, getCard, type Session } from "./store.ts";

interface Done {
  readonly value: unknown;
  readonly notify: readonly string[];
}

type GrantArgs = ReturnType<typeof parse>;
const parse = (raw: unknown) => check(OPS.grant.args, raw);

/** The card or lane the grant sits on. A mate may grant on its own lane, or main on a second mate's lane. */
function target(
  db: DatabaseSync,
  session: Session,
  args: GrantArgs,
): { card: Card | undefined; lane: string } {
  if ((args.lane === undefined) === (args.card === undefined))
    throw new Error("a grant names a lane or a card");
  if (args.branch !== undefined && args.project === undefined)
    throw new Error("a branch scope needs a project");
  requireProject(db, args.project);
  const card = args.card === undefined ? undefined : getCard(db, args.card);
  const lane = card?.lane ?? args.lane ?? "";
  if (lane !== session.lane && !childOf(db, lane, session.lane))
    throw new Error(`lane ${lane} is not yours`);
  return { card, lane };
}

function insert(
  db: DatabaseSync,
  args: GrantArgs,
  on: { card: Card | undefined; lane: string },
): number {
  const optional = [
    args.limits ?? "",
    args.alwaysAsks ?? "",
    args.project ?? null,
    args.branch ?? null,
    args.expires ?? null,
  ];
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO grants (lane, card, words, may, merge, limits, always_asks, scope_project, scope_branch, expires, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      on.card === undefined ? on.lane : null,
      on.card?.id ?? null,
      args.words,
      args.may,
      args.merge ? 1 : 0,
      ...optional,
      Date.now(),
    );
  return Number(lastInsertRowid);
}

export function grant(db: DatabaseSync, session: Session, raw: unknown): Done {
  const args = parse(raw);
  const on = target(db, session, args);
  requireCaptainWords(db, args.words, args.source);
  if (on.card !== undefined) {
    db.prepare("UPDATE grants SET ended_at = ? WHERE card = ? AND ended_at IS NULL").run(
      Date.now(),
      on.card.id,
    );
  }
  const id = insert(db, args, on);
  if (on.card !== undefined) {
    const fields = { grant: id, merge: args.merge };
    addEntry(
      db,
      { card: on.card.id, author: "captain", kind: "grant", body: args.words, fields },
      [],
    );
  }
  return { value: { grant: id }, notify: [] };
}

function requireProject(db: DatabaseSync, project: string | undefined): void {
  if (project === undefined) return;
  if (db.prepare("SELECT 1 FROM projects WHERE name = ?").get(project) === undefined) {
    throw new Error(`project ${project} is not in the registry`);
  }
}

function childOf(db: DatabaseSync, lane: string, parent: string): boolean {
  return (
    db.prepare("SELECT 1 FROM lanes WHERE name = ? AND parent = ?").get(lane, parent) !== undefined
  );
}
