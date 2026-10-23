import type { DatabaseSync } from "node:sqlite";
import {
  check,
  OPS,
  type Card,
  type OpArgs,
  type OpName,
  type ReportStatus,
} from "@fleet/protocol";
import {
  beginAttempt,
  finishJob,
  localLanding,
  nameBranch,
  ownJob,
  runningJobs,
  resumeAttempt,
  startJob,
  touchJob,
} from "./attempts.ts";
import { boardView, cardView } from "./board.ts";
import { requireOpen, statusWith, type Draft } from "./change.ts";
import { closeBegin, closeFinish } from "./closing.ts";
import { comment } from "./comments.ts";
import { acknowledgeMaintenance, maintenanceStatus, requestMaintenance } from "./maintenance.ts";
import { markStopping } from "./incident-lanes.ts";
import { clearFailure, noteControl, reportFailure } from "./incidents.ts";
import { restartCard } from "./restarts.ts";
import { hold, mergeQuestion, release, withdrawMerge, writeMergeQuestion } from "./holds.ts";
import { loadPlan } from "./plans.ts";
import { recordReportedPr } from "./pulls.ts";
import { requireOwedBy } from "./replies.ts";
import type { Timings } from "./timing.ts";
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
type LandingFields =
  | { readonly pr: string; readonly merged?: true }
  | { readonly prNote: string }
  | { readonly landing: string }
  | Record<string, never>;
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

const MAX_PAUSE_MS = 24 * 60 * 60 * 1000;

function requireShortPause(status: ReportStatus, until: number | undefined): void {
  if (status === "paused" && until !== undefined && until > Date.now() + MAX_PAUSE_MS)
    throw new Error(
      "paused until must be within 24 hours from now; ask your mate for a dated hold for longer waits",
    );
}

function rework(db: DatabaseSync, card: Card, status: ReportStatus): string[] {
  return REWORK.has(status) ? withdrawMerge(db, card) : [];
}

const HANDLERS: Record<OpName, Handler> = {
  "maintenance.request": (db, session, raw, timing) =>
    requestMaintenance(db, session, check(OPS["maintenance.request"].args, raw), timing),
  "maintenance.status": (db, _session, raw) => ({
    value: maintenanceStatus(db, check(OPS["maintenance.status"].args, raw).batch),
    notify: [],
  }),
  "maintenance.ack": (db, session, raw) =>
    acknowledgeMaintenance(db, session, check(OPS["maintenance.ack"].args, raw)),
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
      task: args.task,
      delivery: args.delivery,
    });
    return { value: begun, notify: [] };
  },
  "attempt.resume": (db, session, raw) => {
    const { card: id } = check(OPS["attempt.resume"].args, raw);
    const card = ownCard(db, session, id);
    requireOpen(db, card);
    return { value: resumeAttempt(db, card), notify: [] };
  },
  "branch.name": (db, session, raw) => {
    const args = check(OPS["branch.name"].args, raw);
    return { value: nameBranch(db, session.id, args.name), notify: [] };
  },
  "job.start": (db, session, raw, timing) => {
    const args = check(OPS["job.start"].args, raw);
    const job = startJob(db, session.id, args);
    return { value: { job, heartbeatMs: timing.heartbeat }, notify: [] };
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
    const fields = { job: args.job, label: finished.label, exitCode: args.exitCode };
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
  "card.restart": (db, session, raw, timing) =>
    restartCard(db, session, check(OPS["card.restart"].args, raw), timing),
  report: (db, session, raw) => {
    const args = check(OPS.report.args, raw);
    if (session.card === null) throw new Error("only a worker on a card can report");
    requireShortPause(args.status, args.until);
    const card = openCardWithPr(db, session.card, args.pr);
    if (args.replyTo !== undefined) requireOwedBy(db, card, args.replyTo, `worker:${session.id}`);
    const to = args.replyTo === undefined ? reportRoute(db, card, args.status) : [card.lane];
    const withdrawn =
      args.merged === true ? withdrawMerge(db, card, "merged") : rework(db, card, args.status);
    const fields = {
      status: args.status,
      key: args.key,
      until: args.until,
      replyTo: args.replyTo,
      ...landingOf(db, card, args),
    };
    const report: Draft = {
      card: card.id,
      author: `worker:${session.id}`,
      kind: "report",
      body: args.text,
      fields,
    };
    const asked =
      args.status === "done" && args.merged !== true
        ? mergeQuestion(db, card, [report])
        : undefined;
    const statusAfter = statusWith(db, card, asked === undefined ? [report] : [report, asked]);
    addEntry(db, { ...report, fields: { ...fields, statusAfter } }, to);
    const merge = asked === undefined ? [] : writeMergeQuestion(db, card, asked);
    return { value: getCard(db, card.id), notify: [...to, ...withdrawn, ...merge] };
  },
};

function openCardWithPr(db: DatabaseSync, id: number, pr: string | undefined): Card {
  requireOpen(db, getCard(db, id));
  recordReportedPr(db, id, pr);
  return getCard(db, id);
}

function landingOf(db: DatabaseSync, card: Card, args: OpArgs<"report">): LandingFields {
  if (args.merged === true) {
    if (args.status !== "done" || card.pr === null)
      throw new Error("a merged report must be done and name its PR URL");
    return { merged: true, pr: card.pr };
  }
  if (args.status !== "done" || card.kind !== "ship") return {};
  if (card.delivery === "local-only") {
    const local = localLanding(db, card.id);
    if (local === undefined) return { landing: "local-only: the card has no branch" };
    return {
      landing: `local-only: branch ${local.branch} lands on local ${local.base} when the card closes`,
    };
  }
  if (card.pr !== null) return { pr: card.pr };
  return { prNote: "no PR URL reported: the worker reports it with report(pr=<full url>)" };
}

export function performOp(
  db: DatabaseSync,
  session: Session,
  op: OpName,
  args: unknown,
  timing: Timings,
): Done {
  const roles: readonly string[] = OPS[op].roles;
  if (!roles.includes(session.role)) throw new Error(`${session.role} sessions cannot call ${op}`);
  return transaction(db, () => {
    const result = HANDLERS[op](db, session, args, timing);
    noteControl(db, session.id, op);
    return result;
  });
}
