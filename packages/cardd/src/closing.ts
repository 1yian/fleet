import type { DatabaseSync } from "node:sqlite";
import { check, OPS, type Card } from "@fleet/protocol";
import { applyChange, requireOrdinary } from "./change.ts";
import { factsFrom, finishFrom } from "./status.ts";
import { withEcho } from "./echo.ts";
import {
  addEntry,
  cardEntries,
  getCard,
  listProjects,
  mainLane,
  phaseOf,
  reachable,
  type Session,
} from "./store.ts";

interface Done {
  readonly value: unknown;
  readonly notify: readonly string[];
}

function notLanded(db: DatabaseSync, card: Card): string | undefined {
  const { workerDone } = finishFrom(cardEntries(db, card.id));
  const worked = db.prepare("SELECT 1 FROM attempts WHERE card = ?").get(card.id) !== undefined;
  if (worked && !workerDone) return "the worker has not reported done";
  if (card.kind !== "ship") return undefined;
  if (!worked) return "no worker ran it";
  if (card.delivery === "local-only")
    return phaseOf(db, card.id) === "merging"
      ? undefined
      : "its branch has not landed on the local base branch. close lands it once the landing is authorized: yolo on, or the captain's word for it on the merge question";
  if (card.pr !== null)
    return `its PR ${card.pr} has not merged. Once the merge is authorized (yolo on with green checks, or the captain's word for this PR), comment the worker to merge it, then close it`;
  return undefined;
}

function outcome(
  db: DatabaseSync,
  card: Card,
  landed: boolean | undefined,
): { mode: "done" | "dropped"; verify: boolean; land: boolean } {
  const name = `c-${String(card.id)}`;
  const { merged } = finishFrom(cardEntries(db, card.id));
  if (landed === false) {
    if (merged)
      throw new Error(`${name}'s PR merged, so its work landed: close it without landed=false`);
    return { mode: "dropped", verify: false, land: false };
  }
  if (merged) return { mode: "done", verify: false, land: false };
  const why = notLanded(db, card);
  if (why !== undefined) {
    throw new Error(
      `${name} did not land: ${why}. To end it anyway, call close(card, summary=<why it is dropped>, landed=false). That marks it Dropped and archives its work.`,
    );
  }
  const ship = card.kind === "ship";
  return { mode: "done", verify: ship, land: ship && card.delivery === "local-only" };
}

function closable(
  db: DatabaseSync,
  session: Session,
  args: { card: number; landed?: boolean | undefined },
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
  return { card, ...outcome(db, card, args.landed) };
}

export function closeBegin(db: DatabaseSync, session: Session, raw: unknown): Done {
  const args = check(OPS["close.begin"].args, raw);
  const { card, mode, verify, land } = closable(db, session, args);
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
  const hint =
    verify && !land && card.project !== null ? noRepoHint(db, card.id, card.project) : undefined;
  return {
    value: {
      mode,
      verify,
      land,
      attempts,
      refresh: shipCardClonesToRefresh(db, card),
      ...(hint === undefined ? {} : { noRepoHint: hint }),
    },
    notify: [],
  };
}

function noRepoHint(db: DatabaseSync, card: number, project: string): string | undefined {
  const row = db.prepare("SELECT repo FROM projects WHERE name = ?").get(project);
  if (row?.["repo"] !== null) return undefined;
  return `c-${String(card)}'s project ${project} has no GitHub repo on record, so close cannot see whether its PR merged. Set it on the cardd host with \`cardd project repo ${project} <owner>/<name> --db <cards.db>\`, then close again`;
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

export function closeFinish(db: DatabaseSync, session: Session, raw: unknown): Done {
  const args = check(OPS["close.finish"].args, raw);
  const { card } = closable(db, session, { card: args.card, landed: args.mode === "done" });
  const now = Date.now();
  db.prepare(
    `UPDATE sessions SET state = 'closed' WHERE attempt IN
       (SELECT id FROM attempts WHERE card = ? AND state IN ('starting', 'active'))`,
  ).run(card.id);
  db.prepare(
    "UPDATE attempts SET state = 'ended', updated_at = ? WHERE card = ? AND state IN ('starting', 'active')",
  ).run(now, card.id);
  applyChange(db, card, { kind: args.mode === "done" ? "cleanup" : "drop" });
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
