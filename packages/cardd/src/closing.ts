import type { DatabaseSync } from "node:sqlite";
import { check, OPS, type Card } from "@fleet/protocol";
import { requireOrdinary } from "./change.ts";
import { factsFrom, finishFrom } from "./status.ts";
import { withEcho } from "./echo.ts";
import {
  addEntry,
  cardEntries,
  getCard,
  listProjects,
  loadCard,
  mainLane,
  reachable,
  type Session,
} from "./store.ts";

export interface CloseCheck {
  readonly merged: boolean;
  readonly unknown?: string;
}

interface Done {
  readonly value: unknown;
  readonly notify: readonly string[];
}

function notLanded(db: DatabaseSync, card: Card, check?: CloseCheck): string | undefined {
  const { workerDone, emptyBranch } = finishFrom(cardEntries(db, card.id));
  const worked = db.prepare("SELECT 1 FROM attempts WHERE card = ?").get(card.id) !== undefined;
  if (worked && !workerDone) return "the worker has not reported done";
  if (card.kind !== "ship") return undefined;
  if (!worked) return "no worker ran it";
  if (card.delivery === "local-only")
    return emptyBranch || loadCard(db, card.id).standing.stage === "merging"
      ? undefined
      : "its branch has not landed on the local base branch. close lands it once the landing is authorized: yolo on, or the captain's word for it on the merge question";
  if (card.pr !== null) return unmergedPr(card.pr, check);
  return undefined;
}

function unmergedPr(pr: string, check: CloseCheck | undefined): string {
  if (check?.unknown !== undefined)
    return `its PR ${pr} could not be checked on GitHub (${check.unknown}). Fix the access to the project's GitHub account, then close it again`;
  return `its PR ${pr} has not merged on GitHub. Once the merge is authorized (yolo on with green checks, or the captain's word for this PR), comment the worker to merge it and report it merged, then close it`;
}

function outcome(
  db: DatabaseSync,
  card: Card,
  landed: boolean | undefined,
  closeCheck: CloseCheck | undefined,
): { mode: "done" | "dropped"; verify: boolean; land: boolean } {
  const name = `c-${String(card.id)}`;
  const merged = finishFrom(cardEntries(db, card.id)).merged || closeCheck?.merged === true;
  if (landed === false) {
    if (merged)
      throw new Error(`${name}'s PR merged, so its work landed: close it without landed=false`);
    return { mode: "dropped", verify: false, land: false };
  }
  if (merged) return { mode: "done", verify: false, land: false };
  const why = notLanded(db, card, closeCheck);
  if (why !== undefined) {
    throw new Error(
      `${name} did not land: ${why}. To end it anyway, call close(card, summary=<why it is dropped>, landed=false). That marks it Dropped and archives its work.`,
    );
  }
  const ship = card.kind === "ship";
  const empty = finishFrom(cardEntries(db, card.id)).emptyBranch;
  return { mode: "done", verify: ship, land: ship && card.delivery === "local-only" && !empty };
}

function closable(
  db: DatabaseSync,
  session: Session,
  args: { card: number; landed?: boolean | undefined },
  closeCheck: CloseCheck | undefined,
): { card: Card; mode: "done" | "dropped"; verify: boolean; land: boolean } {
  const { card } = reachable(db, session, args.card);
  const name = `c-${String(card.id)}`;
  requireOrdinary(db, card);
  if (card.status === "done" || card.status === "dropped")
    throw new Error(`${name} is already ${card.status}`);
  if (factsFrom(cardEntries(db, card.id)).hold !== undefined) {
    throw new Error(
      `${name} has an open hold; clear it first with hold(card, clear=true), with the captain's words when it waits on him`,
    );
  }
  return { card, ...outcome(db, card, args.landed, closeCheck) };
}

export function closeBegin(
  db: DatabaseSync,
  session: Session,
  raw: unknown,
  closeCheck?: CloseCheck,
): Done {
  const args = check(OPS["close.begin"].args, raw);
  const { card, mode, verify, land } = closable(db, session, args, closeCheck);
  const rows = db
    .prepare(
      `SELECT s.id AS session, a.host AS host, a.branch AS branch, coalesce(c.base_branch, p.default_base) AS base,
         json_extract(p.clones, '$."' || a.host || '"') AS clone, a.state IN ('starting', 'active') AS live
       FROM attempts a JOIN cards c ON c.id = a.card JOIN sessions s ON s.attempt = a.id
       LEFT JOIN projects p ON p.name = c.project
       WHERE a.card = ? ORDER BY a.n`,
    )
    .all(card.id);
  const attempts = rows.flatMap((row) => {
    const { session, host, branch, base, clone, live } = row;
    return typeof session === "string" &&
      typeof host === "string" &&
      typeof branch === "string" &&
      typeof base === "string" &&
      typeof clone === "string"
      ? [{ session, host, branch, base, clone, live: live === 1 }]
      : [];
  });
  return {
    value: {
      mode,
      verify,
      land,
      attempts,
      refresh: shipCardClonesToRefresh(db, card),
    },
    notify: [],
  };
}

function shipCardClonesToRefresh(
  db: DatabaseSync,
  card: Card,
): { project: string; host: string; path: string; base: string }[] {
  if (card.kind !== "ship" || card.delivery === "local-only") return [];
  const project = listProjects(db).find((each) => each.name === card.project);
  if (project === undefined) return [];
  return project.clones.map(({ host, path }) => ({
    project: project.name,
    host,
    path,
    base: project.base,
  }));
}

export function closeFinish(
  db: DatabaseSync,
  session: Session,
  raw: unknown,
  closeCheck?: CloseCheck,
): Done {
  const args = check(OPS["close.finish"].args, raw);
  const { card } = closable(
    db,
    session,
    { card: args.card, landed: args.mode === "done" },
    closeCheck,
  );
  const now = Date.now();
  db.prepare(
    `UPDATE sessions SET state = 'closed' WHERE attempt IN
       (SELECT id FROM attempts WHERE card = ? AND state IN ('starting', 'active'))`,
  ).run(card.id);
  db.prepare(
    "UPDATE attempts SET state = 'ended', updated_at = ? WHERE card = ? AND state IN ('starting', 'active')",
  ).run(now, card.id);
  const main = mainLane(db);
  const other = session.lane === card.lane ? main : card.lane;
  const closed = { outcome: args.mode, archives: args.archives, left: args.left };
  const to = withEcho(db, session, card, other === session.lane ? [] : [other]);
  addEntry(
    db,
    {
      card: card.id,
      author: `mate:${session.lane}`,
      kind: "cleanup",
      body: args.text,
      fields: closed,
    },
    to,
  );
  return { value: getCard(db, card.id), notify: to };
}
