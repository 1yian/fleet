// The operations that sessions call (spec section 11). Each runs inside one
// transaction and returns the sessions that have new entries to push.
import type { DatabaseSync } from "node:sqlite";
import { check, OPS, type Card, type OpName, type ReportStatus } from "@fleet/protocol";
import { beginAttempt, finishJob, runningJobs, startJob, touchJob } from "./attempts.ts";
import type { Timing } from "./timed.ts";
import { factsFrom, nextStatus, type Change } from "./status.ts";
import {
  addCard,
  addEntry,
  cardEntries,
  getCard,
  listCards,
  setStatus,
  workerOf,
  type Session,
} from "./store.ts";

interface Done {
  readonly value: unknown;
  readonly notify: readonly string[];
}
type Handler = (db: DatabaseSync, session: Session, args: unknown, timing: Timing) => Done;

/** Reports that always reach the lane mate (spec section 10.1). */
const TO_MATE: ReadonlySet<ReportStatus> = new Set([
  "in-review",
  "done",
  "failed",
  "blocked",
  "needs-decision",
  "resolved",
  "stopped",
]);

function applyChange(db: DatabaseSync, card: Card, change: Change): void {
  const facts = { ...factsFrom(cardEntries(db, card.id)), status: card.status, kind: card.kind };
  const status = nextStatus(facts, change);
  if (status instanceof Error) throw status;
  setStatus(db, card.id, status);
}

function ownCard(db: DatabaseSync, session: Session, id: number): Card {
  const card = getCard(db, id);
  if (card.lane !== session.lane) throw new Error(`c-${String(id)} belongs to lane ${card.lane}`);
  return card;
}

/**
 * A report reaches the mate if its status hands off, or if it is the first report
 * after a comment (spec section 10.3). Then it carries the comment it follows.
 */
function reportRoute(
  db: DatabaseSync,
  card: Card,
  status: ReportStatus,
): { to: string[]; re?: string } {
  const entries = cardEntries(db, card.id);
  const comment = entries.findLast((entry) => entry.kind === "comment");
  const report = entries.findLast((entry) => entry.kind === "report");
  const firstAfterComment = comment !== undefined && comment.id > (report?.id ?? 0);
  if (firstAfterComment) return { to: [card.lane], re: comment.body };
  return { to: TO_MATE.has(status) ? [card.lane] : [] };
}

const HANDLERS: Record<OpName, Handler> = {
  "card.new": (db, session, raw) => {
    const args = check(OPS["card.new"].args, raw);
    return { value: addCard(db, { ...args, lane: session.lane }), notify: [] };
  },
  board: (db) => ({ value: listCards(db), notify: [] }),
  comment: (db, session, raw) => {
    const args = check(OPS.comment.args, raw);
    const card = ownCard(db, session, args.card);
    const worker = workerOf(db, card.id);
    const to = worker === undefined ? [] : [worker];
    applyChange(db, card, { kind: "comment", resolves: args.resolves });
    const fields = { resolves: args.resolves, now: args.now };
    addEntry(
      db,
      { card: card.id, author: `mate:${session.lane}`, kind: "comment", body: args.text, fields },
      to,
    );
    return { value: getCard(db, card.id), notify: to };
  },
  "attempt.begin": (db, session, raw) => {
    const args = check(OPS["attempt.begin"].args, raw);
    const card = ownCard(db, session, args.card);
    const begun = beginAttempt(db, card, {
      host: args.host,
      replace: args.replace ?? false,
      task: args.task,
    });
    if (!begun.resumed) applyChange(db, card, { kind: "dispatch" });
    return { value: begun, notify: [] };
  },
  "job.start": (db, session, raw, timing) => {
    const args = check(OPS["job.start"].args, raw);
    const job = startJob(db, session.id, args.label, args.command);
    return { value: { job, heartbeatMs: timing.heartbeatMs }, notify: [] };
  },
  "job.alive": (db, session, raw) => {
    const args = check(OPS["job.alive"].args, raw);
    return { value: { running: touchJob(db, session.id, args.job) }, notify: [] };
  },
  "job.finish": (db, session, raw) => {
    const args = check(OPS["job.finish"].args, raw);
    const label = finishJob(db, session.id, {
      id: args.job,
      exitCode: args.exitCode,
      outputTail: args.outputTail,
    });
    if (label === undefined || session.card === null)
      return { value: { recorded: false }, notify: [] };
    const fields = { job: args.job, label, exitCode: args.exitCode };
    const entry = {
      card: session.card,
      author: `job:${String(args.job)}`,
      kind: "job-result",
      body: args.outputTail,
      fields,
    };
    addEntry(db, entry, [session.id]);
    return { value: { recorded: true }, notify: [session.id] };
  },
  jobs: (db, session) => ({ value: runningJobs(db, session.id), notify: [] }),
  report: (db, session, raw) => {
    const args = check(OPS.report.args, raw);
    if (session.card === null) throw new Error("only a worker on a card can report");
    const card = getCard(db, session.card);
    const { to, re } = reportRoute(db, card, args.status);
    applyChange(db, card, { kind: "report", status: args.status });
    const fields = { status: args.status, key: args.key, until: args.until, re };
    addEntry(
      db,
      { card: card.id, author: `worker:${session.id}`, kind: "report", body: args.text, fields },
      to,
    );
    return { value: getCard(db, card.id), notify: to };
  },
};

/** Runs an operation for a session. Throws if the session's role may not call it. */
export function runOp(
  db: DatabaseSync,
  session: Session,
  op: OpName,
  args: unknown,
  timing: Timing,
): Done {
  const roles: readonly string[] = OPS[op].roles;
  if (!roles.includes(session.role)) throw new Error(`${session.role} sessions cannot call ${op}`);
  return HANDLERS[op](db, session, args, timing);
}
