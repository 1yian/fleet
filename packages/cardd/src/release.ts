import type { DatabaseSync } from "node:sqlite";
import { check, OPS, type Card } from "@fleet/protocol";
import { requireCaptainWords } from "./authority.ts";
import { requireOpen, type Draft } from "./change.ts";
import { withEcho } from "./echo.ts";
import { answerHold, askAgain, hearers, holdOf, requireMainsHold } from "./holds.ts";
import type { Hold } from "./status.ts";
import { addEntry, getCard, parentOf, reachable, workerOf, type Session } from "./store.ts";
import { canSee } from "./waits.ts";

interface Done {
  readonly value: unknown;
  readonly notify: readonly string[];
}

function toWorkerOf(db: DatabaseSync, card: Card, open: Hold): string[] {
  const worker = open.fromWorker ? workerOf(db, card.id) : undefined;
  return worker === undefined ? [] : [worker];
}

function requireNoteMayClear(card: Card, open: Hold, own: boolean): void {
  const name = `c-${String(card.id)}`;
  if (open.holder === "captain" || open.merge)
    throw new Error(`${name} waits on the captain: clear it with his exact words`);
  if (own) return;
  if (open.holder !== "main")
    throw new Error(`${name} waits on ${card.lane}'s mate, who resolves it or escalates it`);
  if (open.unlanded)
    throw new Error(
      `${name} holds finished work that has not landed, so whether to keep, land, or discard it is the captain's call: escalate it with hold(card, to="captain", question, options), or clear it with his exact words`,
    );
}

function noteRelease(
  db: DatabaseSync,
  session: Session,
  card: Card,
  open: Hold,
  body: string,
  fields: Record<string, unknown>,
): Done {
  const draft: Draft = {
    card: card.id,
    author: `mate:${session.lane}`,
    kind: "release",
    body,
    fields,
  };
  requireOpen(db, card);
  const heard = [...hearers(db, card, session.lane, [open.holder]), ...toWorkerOf(db, card, open)];
  const to = withEcho(db, session, card, heard);
  addEntry(db, draft, to);
  return { value: getCard(db, card.id), notify: [...to, ...askAgain(db, card)] };
}

function refusalOf(card: Card, open: Hold, other: Card): string | undefined {
  const name = `c-${String(card.id)}`;
  if (other.id === card.id) return `${name} cannot supersede its own hold`;
  if (other.status === "dropped")
    return `c-${String(other.id)} was dropped, so it supersedes nothing`;
  if (other.project !== card.project)
    return `c-${String(other.id)} is in another project, so it does not supersede ${name}'s hold`;
  if (other.createdAt < open.openedAt)
    return `c-${String(other.id)} is older than ${name}'s hold, so it cannot have replaced it`;
  return undefined;
}

function supersederLabel(
  db: DatabaseSync,
  session: Session,
  card: Card,
  open: Hold,
  by: number | string,
): string {
  const ids =
    typeof by === "string"
      ? db.prepare("SELECT id FROM cards WHERE lower(pr) = lower(?) ORDER BY id").all(by)
      : db.prepare("SELECT id FROM cards WHERE id = ?").all(by);
  const seen = ids
    .map((row) => getCard(db, Number(row["id"])))
    .filter((other) => canSee(db, session.lane, other.lane));
  if (seen.length === 0)
    throw new Error(
      typeof by === "string"
        ? `no card has recorded ${by}, so it supersedes nothing`
        : `no card c-${String(by)}`,
    );
  const refusals = seen.map((other) => refusalOf(card, open, other));
  if (refusals.includes(undefined)) return typeof by === "string" ? by : `c-${String(by)}`;
  throw new Error(refusals[0] ?? "");
}

function requireMayRetire(
  db: DatabaseSync,
  session: Session,
  card: Card,
  open: Hold,
  own: boolean,
): void {
  const name = `c-${String(card.id)}`;
  if (open.merge)
    throw new Error(
      `${name}'s hold is a merge question: only the captain's approval answers it, and retiring never approves`,
    );
  if (open.unlanded)
    throw new Error(
      `${name} holds finished work that has not landed, so whether to keep, land, or discard it stays the captain's call: it cannot be retired`,
    );
  requireMainsHold(card, own, open);
  if (open.holder === "captain" && parentOf(db, session.lane) !== null)
    throw new Error(`${name} waits on the captain, so only main retires it: ask main`);
  if (open.fromWorker && open.keys.length > 0 && workerOf(db, card.id) !== undefined)
    throw new Error(
      `${name}'s worker is still live and waiting on this decision, so it is not obsolete: answer it, hold it again, or stop the worker first`,
    );
}

function retire(
  db: DatabaseSync,
  session: Session,
  card: Card,
  open: Hold,
  own: boolean,
  retiring: { reason: string; supersededBy: number | string },
): Done {
  requireMayRetire(db, session, card, open, own);
  const supersededBy = supersederLabel(db, session, card, open, retiring.supersededBy);
  const fields = { hold: open.entry, occurrence: open.occurrence, retired: true, supersededBy };
  const body = `Retired as obsolete, not approved or decided. ${retiring.reason.trim()} Superseded by ${supersededBy}.`;
  return noteRelease(db, session, card, open, body, fields);
}

export function release(db: DatabaseSync, session: Session, raw: unknown): Done {
  const args = check(OPS.release.args, raw);
  const { card, own } = reachable(db, session, args.card);
  const name = `c-${String(card.id)}`;
  const open = holdOf(db, card);
  if (open === undefined) throw new Error(`${name} has no open hold`);
  const given = [args.words, args.note, args.retire].filter((each) => each !== undefined);
  if (given.length !== 1)
    throw new Error(
      "clearing a hold needs exactly one of the captain's exact words, your own note, or retire with its evidence",
    );
  if (args.retire !== undefined) {
    if (args.choice !== undefined)
      throw new Error(
        "retiring a hold picks no option and records no approval, so choice is refused",
      );
    return retire(db, session, card, open, own, args.retire);
  }
  if (args.words !== undefined) {
    const source = args.source ?? "record";
    requireCaptainWords(db, args.words, source);
    return answerHold(db, session.lane, card, open, { ...args, words: args.words, source });
  }
  requireNoteMayClear(card, open, own);
  const fields = { hold: open.entry, occurrence: open.occurrence };
  const body = args.note ?? "";
  return noteRelease(db, session, card, open, body, fields);
}
