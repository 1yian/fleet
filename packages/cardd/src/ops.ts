import type { DatabaseSync } from "node:sqlite";
import { check, OPS, type Card, type OpName, type ReportStatus } from "@fleet/protocol";
import {
  beginAttempt,
  cancelReviewWaits,
  finishJob,
  localLanding,
  nameBranch,
  ownJob,
  runningJobs,
  startJob,
  touchJob,
} from "./attempts.ts";
import { boardView, cardView } from "./board.ts";
import { requireOpen, statusWith, type Draft } from "./change.ts";
import { recordMerge } from "./check.ts";
import { closeBegin, closeFinish } from "./closing.ts";
import { comment } from "./comments.ts";
import { markStopping } from "./incident-lanes.ts";
import { clearFailure, noteControl, recover, reportFailure } from "./incidents.ts";
import { hold, mergeQuestion, release, withdrawMerge, writeMergeQuestion } from "./holds.ts";
import type { PullRequest } from "./github.ts";
import { loadPlan } from "./plans.ts";
import { lookUpPr, recordReportedPr } from "./pulls.ts";
import { requireOwedBy } from "./replies.ts";
import { factsFrom } from "./status.ts";
import type { Timings } from "./timing.ts";
import { recordValidation, revalidate, startValidation } from "./validations.ts";
import { scriptWake } from "./wakes.ts";
import {
  addCard,
  addEntry,
  cardEntries,
  getCard,
  listProjects,
  mainLane,
  parentOf,
  transaction,
  type Session,
} from "./store.ts";

interface Done {
  readonly value: unknown;
  readonly notify: readonly string[];
}
type PrFields =
  | { readonly pr: string; readonly prState: PullRequest["state"] }
  | { readonly prNote: string }
  | { readonly landing: string }
  | Record<string, never>;
type Handler = (
  db: DatabaseSync,
  session: Session,
  args: unknown,
  timing: Timings,
  pr: PrFields,
) => Done;

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

function reportRoute(db: DatabaseSync, card: Card, status: ReportStatus): string[] {
  const entries = cardEntries(db, card.id);
  const comment = entries.findLast(
    (entry) =>
      entry.kind === "comment" &&
      (entry.fields["task"] === true || entry.fields["for"] === "worker"),
  );
  const report = entries.findLast((entry) => entry.kind === "report");
  const firstAfterComment = comment !== undefined && comment.id > (report?.id ?? 0);
  return firstAfterComment || TO_MATE.has(status) ? [card.lane] : [];
}

const REWORK: ReadonlySet<ReportStatus> = new Set([
  "in-review",
  "needs-decision",
  "failed",
  "blocked",
  "stopped",
]);

function rework(db: DatabaseSync, card: Card, status: ReportStatus): string[] {
  if (status === "stopped") cancelReviewWaits(db, card.id);
  return REWORK.has(status) ? withdrawMerge(db, card) : [];
}

function reviewFeedback(
  db: DatabaseSync,
  id: number,
  fields: { job: number; label: string; exitCode: number; resolves: string },
  body: string,
  session: string,
): void {
  const entry: Draft = { card: id, author: "captain", kind: "review-feedback", body, fields };
  const open = factsFrom(cardEntries(db, id)).hold?.keys.includes(fields.resolves) === true;
  if (open) requireOpen(db, getCard(db, id));
  addEntry(db, entry, [session]);
}

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
  board: (db, session) => {
    const main = session.lane === mainLane(db);
    return {
      value: boardView(db).cards.filter((card) => main || card.lane === session.lane),
      notify: [],
    };
  },
  card: (db, session, raw) => {
    const { card } = check(OPS.card.args, raw);
    if (session.lane !== mainLane(db) && getCard(db, card).lane !== session.lane)
      throw new Error(`c-${String(card)} is in another lane; ask main`);
    return { value: cardView(db, card), notify: [] };
  },
  projects: (db) => ({ value: listProjects(db), notify: [] }),
  comment,
  "lane.plan": (db, session, _raw, timing) => ({
    value: loadPlan(db, session.lane, timing.wall()),
    notify: [],
  }),
  wake: (db, session, raw) => {
    const entry = scriptWake(db, session.lane, check(OPS.wake.args, raw));
    return { value: { entry }, notify: [session.lane] };
  },
  "attempt.begin": (db, session, raw) => {
    const args = check(OPS["attempt.begin"].args, raw);
    const card = ownCard(db, session, args.card);
    requireOpen(db, card);
    if (card.kind === "captain") {
      throw new Error(
        `c-${String(card.id)} is a captain card: it is for the captain alone, so no worker runs it`,
      );
    }
    const begun = beginAttempt(db, card, {
      host: args.host,
      replace: args.replace ?? false,
      task: args.task,
      delivery: args.delivery,
    });
    return { value: begun, notify: [] };
  },
  "branch.name": (db, session, raw) => {
    const args = check(OPS["branch.name"].args, raw);
    return { value: nameBranch(db, session.id, args.name), notify: [] };
  },
  "job.start": (db, session, raw, timing) => {
    const args = check(OPS["job.start"].args, raw);
    const { id, key } = startJob(db, session.id, { ...args, review: args.review !== undefined });
    const value = { job: id, heartbeatMs: timing.heartbeat, key };
    if (key === null || args.review === undefined) return { value, notify: [] };
    const decision = { status: "needs-decision", key, text: args.review };
    return { value, notify: HANDLERS.report(db, session, decision, timing, {}).notify };
  },
  "job.alive": (db, session, raw) => {
    const args = check(OPS["job.alive"].args, raw);
    return { value: { running: touchJob(db, session.id, args.job) }, notify: [] };
  },
  "job.finish": (db, session, raw) => {
    const args = check(OPS["job.finish"].args, raw);
    const finished = finishJob(db, session.id, {
      id: args.job,
      exitCode: args.exitCode,
      outputTail: args.outputTail,
    });
    if (finished === undefined || session.card === null)
      return { value: { recorded: false }, notify: [] };
    const { label, resolves } = finished;
    const fields = { job: args.job, label, exitCode: args.exitCode };
    if (resolves !== null) {
      reviewFeedback(db, session.card, { ...fields, resolves }, args.outputTail, session.id);
      return { value: { recorded: true }, notify: [session.id] };
    }
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
  "job.stop": (db, session, raw) => {
    const args = check(OPS["job.stop"].args, raw);
    const own = ownJob(db, session.id, args.job);
    if (own === undefined)
      throw new Error(
        `job ${String(args.job)} is not one of this worker's jobs: nothing was stopped`,
      );
    if (own.review)
      throw new Error(
        `job ${String(args.job)} is a review wait: end its page with lavish-axi end instead`,
      );
    return { value: { label: own.label, running: own.running }, notify: [] };
  },
  jobs: (db, session) => ({ value: runningJobs(db, session.id), notify: [] }),
  "incident.report": (db, session, raw, timing) =>
    reportFailure(db, session, check(OPS["incident.report"].args, raw), timing),
  "incident.clear": (db, session, raw) =>
    clearFailure(db, session, check(OPS["incident.clear"].args, raw)),
  "lane.stopping": (db, session, raw) => ({
    value: markStopping(db, session, check(OPS["lane.stopping"].args, raw)),
    notify: [],
  }),
  "incident.recover": (db, session, raw, timing) =>
    recover(db, session, check(OPS["incident.recover"].args, raw), timing),
  "validation.start": (db, session, raw) =>
    startValidation(db, session, check(OPS["validation.start"].args, raw)),
  "validation.result": (db, session, raw) =>
    recordValidation(db, session, check(OPS["validation.result"].args, raw)),
  "validation.revalidate": (db, session, raw) =>
    revalidate(db, session, check(OPS["validation.revalidate"].args, raw)),
  report: (db, session, raw, _timing, pr) => {
    const args = check(OPS.report.args, raw);
    if (session.card === null) throw new Error("only a worker on a card can report");
    const card = getCard(db, session.card);
    requireOpen(db, card);
    if (args.replyTo !== undefined) requireOwedBy(db, card, args.replyTo, `worker:${session.id}`);
    const to = args.replyTo === undefined ? reportRoute(db, card, args.status) : [card.lane];
    const withdrawn = rework(db, card, args.status);
    const fields = {
      status: args.status,
      key: args.key,
      until: args.until,
      replyTo: args.replyTo,
      ...pr,
    };
    const report: Draft = {
      card: card.id,
      author: `worker:${session.id}`,
      kind: "report",
      body: args.text,
      fields,
    };
    const approvable = !("prState" in pr) || pr.prState === "OPEN";
    const asked =
      args.status === "done" && approvable ? mergeQuestion(db, card, [report]) : undefined;
    const statusAfter = statusWith(db, card, asked === undefined ? [report] : [report, asked]);
    addEntry(db, { ...report, fields: { ...fields, statusAfter } }, to);
    const merge = asked === undefined ? [] : writeMergeQuestion(db, card, asked);
    return { value: getCard(db, card.id), notify: [...to, ...withdrawn, ...merge] };
  },
};

async function findReportedPr(db: DatabaseSync, session: Session, raw: unknown): Promise<PrFields> {
  const { status, pr } = check(OPS.report.args, raw);
  if (status !== "done" || session.card === null) return {};
  const card = getCard(db, session.card);
  if (card.kind !== "ship") return {};
  if (card.delivery === "local-only") {
    const local = localLanding(db, card.id);
    if (local === undefined) return { landing: "local-only: the card has no branch" };
    return {
      landing: `local-only: branch ${local.branch} lands on local ${local.base} when the card closes`,
    };
  }
  recordReportedPr(db, card.id, pr);
  const found = await lookUpPr(db, session.card);
  if (found.kind === "found") return { pr: found.pr.url, prState: found.pr.state };
  if (found.kind === "unknown") return { prNote: `PR unknown: ${found.reason}` };
  if (found.branches.length === 0) return { prNote: "no PR: the card has no branch" };
  return { prNote: `no PR has branch ${found.branches.join(" or ")} as its head` };
}

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
  const pr = op === "report" ? await findReportedPr(db, session, args) : {};
  const done = transaction(db, () => {
    const result = HANDLERS[op](db, session, args, timing, pr);
    noteControl(db, session.id, op);
    return result;
  });
  return { ...done, notify: [...new Set([...merged, ...done.notify])] };
}
