// The operations that sessions call (spec section 11). Each runs inside one
// transaction and returns the sessions that have new entries to push.
import type { DatabaseSync } from "node:sqlite";
import {
  check,
  MERGE_OPTIONS,
  OPS,
  type Card,
  type OpName,
  type ReportStatus,
} from "@fleet/protocol";
import { answer, ask, handback, hold, openMergeAsk } from "./asks.ts";
import { beginAttempt, finishJob, runningJobs, startJob, touchJob } from "./attempts.ts";
import { applyChange } from "./change.ts";
import { closeBegin, closeFinish } from "./closing.ts";
import { grant } from "./grants.ts";
import { merge } from "./merge.ts";
import type { Timings } from "./timing.ts";
import {
  addCard,
  addEntry,
  cardEntries,
  getCard,
  listCards,
  listProjects,
  mainLane,
  transaction,
  workerOf,
  type Session,
} from "./store.ts";

interface Done {
  readonly value: unknown;
  readonly notify: readonly string[];
}
type Handler = (db: DatabaseSync, session: Session, args: unknown, timing: Timings) => Done;

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

/**
 * A ship card that is done without a grant for merging waits for the captain's
 * approval (spec section 7.5). The question skips main's filter; main gets one line.
 */
function askToMerge(db: DatabaseSync, card: Card): string[] {
  if (card.kind !== "ship" || card.status !== "needs-you" || openMergeAsk(db, card) !== undefined)
    return [];
  const main = mainLane(db);
  const to = main === card.lane ? [] : [main];
  const body = `Merge ${card.pr ?? "the branch"} for c-${String(card.id)}: ${card.title}?`;
  const fields = { options: [...MERGE_OPTIONS], merge: true, pr: card.pr };
  addEntry(db, { card: card.id, author: "fleet", kind: "ask", body, fields }, to);
  return to;
}

const HANDLERS: Record<Exclude<OpName, "merge">, Handler> = {
  "close.begin": closeBegin,
  "close.finish": closeFinish,
  grant,
  ask,
  answer,
  handback,
  hold,
  "card.new": (db, session, raw) => {
    const { lane, ...args } = check(OPS["card.new"].args, raw);
    if (lane === undefined || lane === session.lane)
      return { value: addCard(db, { ...args, lane: session.lane }), notify: [] };
    // Main routes work to a second mate: the card lives in that lane, and its mate hears of it.
    const parent = db.prepare("SELECT parent FROM lanes WHERE name = ?").get(lane)?.["parent"];
    if (parent !== session.lane) throw new Error(`lane ${lane} is not one of your second mates`);
    const card = addCard(db, { ...args, lane });
    const body = `New card from ${session.lane}: ${card.title}${card.intent === "" ? "" : `\n\nCaptain's words: ${card.intent}`}`;
    addEntry(
      db,
      {
        card: card.id,
        author: `mate:${session.lane}`,
        kind: "note",
        body,
        fields: { routed: true },
      },
      [lane],
    );
    return { value: card, notify: [lane] };
  },
  board: (db) => ({ value: listCards(db), notify: [] }),
  projects: (db) => ({ value: listProjects(db), notify: [] }),
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
    return { value: { job, heartbeatMs: timing.heartbeat }, notify: [] };
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
    if (args.pr !== undefined)
      db.prepare("UPDATE cards SET pr = ? WHERE id = ?").run(args.pr, session.card);
    const card = getCard(db, session.card);
    const { to, re } = reportRoute(db, card, args.status);
    applyChange(db, card, { kind: "report", status: args.status });
    const statusAfter = getCard(db, card.id).status;
    const fields = {
      status: args.status,
      key: args.key,
      until: args.until,
      pr: args.pr,
      re,
      statusAfter,
    };
    addEntry(
      db,
      { card: card.id, author: `worker:${session.id}`, kind: "report", body: args.text, fields },
      to,
    );
    const merge = args.status === "done" ? askToMerge(db, getCard(db, card.id)) : [];
    return { value: getCard(db, card.id), notify: [...to, ...merge] };
  },
};

/** Runs an operation for a session. Throws if the session's role may not call it. merge waits for gh. */
export async function performOp(
  db: DatabaseSync,
  session: Session,
  op: OpName,
  args: unknown,
  timing: Timings,
): Promise<Done> {
  const roles: readonly string[] = OPS[op].roles;
  if (!roles.includes(session.role)) throw new Error(`${session.role} sessions cannot call ${op}`);
  if (op === "merge") return merge(db, session, args);
  return transaction(db, () => HANDLERS[op](db, session, args, timing));
}
