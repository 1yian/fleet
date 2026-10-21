import type { DatabaseSync } from "node:sqlite";
import { check, OPS, type Card, type OpName, type ReportStatus } from "@fleet/protocol";
import { beginAttempt, finishJob, runningJobs, startJob, touchJob } from "./attempts.ts";
import { boardView, cardView } from "./board.ts";
import { applyChange, requireOrdinary, type Draft } from "./change.ts";
import { recordMerge } from "./check.ts";
import { closeBegin, closeFinish } from "./closing.ts";
import { comment } from "./comments.ts";
import { hold, mergeQuestion, release, withdrawMerge, writeMergeQuestion } from "./holds.ts";
import type { Timings } from "./timing.ts";
import {
  addCard,
  addEntry,
  cardEntries,
  getCard,
  listProjects,
  parentOf,
  transaction,
  type Session,
} from "./store.ts";

interface Done {
  readonly value: unknown;
  readonly notify: readonly string[];
}
type Handler = (db: DatabaseSync, session: Session, args: unknown, timing: Timings) => Done;

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

function reportRoute(
  db: DatabaseSync,
  card: Card,
  status: ReportStatus,
): { to: string[]; re?: string } {
  const entries = cardEntries(db, card.id);
  const comment = entries.findLast(
    (entry) =>
      entry.kind === "comment" &&
      (entry.fields["task"] === true || entry.fields["for"] === "worker"),
  );
  const report = entries.findLast((entry) => entry.kind === "report");
  const firstAfterComment = comment !== undefined && comment.id > (report?.id ?? 0);
  if (firstAfterComment) return { to: [card.lane], re: comment.body };
  return { to: TO_MATE.has(status) ? [card.lane] : [] };
}

const REWORK: ReadonlySet<ReportStatus> = new Set([
  "in-review",
  "needs-decision",
  "failed",
  "blocked",
  "stopped",
]);

const HANDLERS: Record<OpName, Handler> = {
  "close.begin": closeBegin,
  "close.finish": closeFinish,
  hold,
  release,
  "card.new": (db, session, raw) => {
    const { lane, ...args } = check(OPS["card.new"].args, raw);
    if (lane !== undefined && lane !== session.lane) {
      const hint =
        parentOf(db, lane) === session.lane
          ? `To hand work to ${lane}, comment on its lane card: comment(lane="${lane}", text=...). It creates its own card.`
          : "A mate creates cards only in its own lane.";
      throw new Error(`card_new cannot create a card in lane ${lane}. ${hint}`);
    }
    return { value: addCard(db, { ...args, lane: session.lane }), notify: [] };
  },
  board: (db) => ({ value: boardView(db).cards, notify: [] }),
  card: (db, _session, raw) => ({
    value: cardView(db, check(OPS.card.args, raw).card),
    notify: [],
  }),
  projects: (db) => ({ value: listProjects(db), notify: [] }),
  comment,
  "attempt.begin": (db, session, raw) => {
    const args = check(OPS["attempt.begin"].args, raw);
    const card = ownCard(db, session, args.card);
    requireOrdinary(db, card);
    if (card.kind === "captain") {
      throw new Error(
        `c-${String(card.id)} is a captain card: it is for the captain alone, so no worker runs it`,
      );
    }
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
    const withdrawn = REWORK.has(args.status) ? withdrawMerge(db, card) : [];
    const fields = { status: args.status, key: args.key, until: args.until, pr: args.pr, re };
    const report: Draft = {
      card: card.id,
      author: `worker:${session.id}`,
      kind: "report",
      body: args.text,
      fields,
    };
    const asked = args.status === "done" ? mergeQuestion(db, card, [report]) : undefined;
    const statusAfter = applyChange(
      db,
      card,
      { kind: "report", status: args.status },
      asked === undefined ? [report] : [report, asked],
    );
    addEntry(db, { ...report, fields: { ...fields, statusAfter } }, to);
    const merge = asked === undefined ? [] : writeMergeQuestion(db, card, asked);
    return { value: getCard(db, card.id), notify: [...to, ...withdrawn, ...merge] };
  },
};

export async function performOp(
  db: DatabaseSync,
  session: Session,
  op: OpName,
  args: unknown,
  timing: Timings,
): Promise<Done> {
  const roles: readonly string[] = OPS[op].roles;
  if (!roles.includes(session.role)) throw new Error(`${session.role} sessions cannot call ${op}`);
  const merged = op === "close.begin" ? await recordMerge(db, check(OPS[op].args, args).card) : [];
  const done = transaction(db, () => HANDLERS[op](db, session, args, timing));
  return { ...done, notify: [...new Set([...merged, ...done.notify])] };
}
