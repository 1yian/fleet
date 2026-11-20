import type { DatabaseSync } from "node:sqlite";
import {
  check,
  OPS,
  type Card,
  type OpArgs,
  type OpName,
  type ReportStatus,
} from "@fleet/protocol";
import { requireCommentsRead } from "./deliveries.ts";
import { beginAttempt, localLanding, nameBranch, resumeAttempt } from "./attempts.ts";
import { hasJobWait } from "./jobs.ts";
import { JOB_HANDLERS } from "./job-ops.ts";
import { boardFor, cardView } from "./board.ts";
import { requireOpen, statusWith, type Draft } from "./change.ts";
import { closeBegin, closeFinish, type CloseCheck } from "./closing.ts";
import { comment } from "./comments.ts";
import { listComplaints, recordComplaint } from "./complaints.ts";
import {
  acknowledgeMaintenance,
  maintenanceStatus,
  readMaintenance,
  requestMaintenance,
} from "./maintenance.ts";
import { keepingRefusals } from "./incident-escalation.ts";
import { markStopping } from "./incident-lanes.ts";
import { clearFailure, noteControl, reportFailure } from "./incidents.ts";
import { generationOf } from "./incident-store.ts";
import { restartCard, restartFailed, restartNotice } from "./restarts.ts";
import {
  hold,
  holdOf,
  mergeQuestion,
  release,
  withdrawMerge,
  writeMergeQuestion,
} from "./holds.ts";
import { ensurePersonalProject } from "./personal.ts";
import { loadPlan } from "./plans.ts";
import { doneStands } from "./status.ts";
import { emptyLocalBranch } from "./empty-branch.ts";
import { recordReportedPr, type Hosts } from "./pulls.ts";
import { normalizeReport, reverifyAtClose } from "./merged-report.ts";
import { requireOwedBy, workerOwedIds } from "./replies.ts";
import type { Timings } from "./timing.ts";
import { listSchedules, removeSchedule, setSchedule } from "./schedules.ts";
import { scriptWake } from "./wakes.ts";
import {
  addCard,
  addEntry,
  cardEntries,
  getCard,
  loadCard,
  mainLane,
  setYolo,
  parentOf,
  transaction,
  type Session,
} from "./store.ts";
import { listProjects } from "./projects.ts";

interface Done {
  readonly value: unknown;
  readonly notify: readonly string[];
}
type LandingFields =
  | { readonly pr: string; readonly merged?: true }
  | { readonly prNote: string }
  | { readonly landing: string }
  | Record<string, never>;
type Handler = (
  db: DatabaseSync,
  session: Session,
  args: unknown,
  timing: Timings,
  note?: string,
  closeCheck?: CloseCheck,
  emptyBranch?: true,
) => Done;

const TO_MATE: ReadonlySet<ReportStatus> = new Set([
  "in-review",
  "done",
  "merged",
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

const NOTHING_RUNS =
  "Nothing runs for this pause. Your mate was told, and is told again if the pause ends and nothing ran since. If you wait on a task that finishes on its own, start a run_long watcher for it.";

function unwatchedPause(db: DatabaseSync, session: Session, status: ReportStatus): boolean {
  return status === "paused" && !hasJobWait(db, session.id);
}

function reportRoute(db: DatabaseSync, card: Card, mateHears: boolean): string[] {
  const entries = cardEntries(db, card.id);
  const comment = entries.findLast(
    (entry) =>
      entry.kind === "comment" &&
      (entry.fields["task"] === true || entry.fields["for"] === "worker"),
  );
  const report = entries.findLast((entry) => entry.kind === "report");
  const firstAfterComment = comment !== undefined && comment.id > (report?.id ?? 0);
  return firstAfterComment || mateHears ? [card.lane] : [];
}

function reportRecipients(
  db: DatabaseSync,
  session: Session,
  card: Card,
  args: ReportArgs,
  unwatched: boolean,
): string[] {
  if (args.replyTo === undefined)
    return reportRoute(db, card, TO_MATE.has(args.status) || unwatched);
  requireOwedBy(db, card, args.replyTo, `worker:${session.id}`);
  return [card.lane];
}

const stopsNothing = (db: DatabaseSync, card: Card, status: ReportStatus): boolean =>
  status === "stopped" && doneStands(cardEntries(db, card.id));

const REWORK: ReadonlySet<ReportStatus> = new Set([
  "in-review",
  "needs-decision",
  "failed",
  "blocked",
  "stopped",
]);

const MAX_PAUSE_MS = 24 * 60 * 60 * 1000;

function requireDatedPause(status: ReportStatus, until: number | undefined): void {
  if (status !== "paused") return;
  if (until === undefined || until <= Date.now())
    throw new Error(
      "paused needs until, a time in the future when the wait ends: a quota reset, a third party, a CI run, or a date. If you wait on your mate's action, report blocked instead: that wakes your mate, and paused does not",
    );
  if (until > Date.now() + MAX_PAUSE_MS)
    throw new Error(
      "paused until must be within 24 hours from now; ask your mate for a dated hold for longer waits",
    );
}

function rework(
  db: DatabaseSync,
  card: Card,
  status: ReportStatus,
  emptyBranch: true | undefined,
): string[] {
  if (emptyBranch === true) return withdrawMerge(db, card, "empty");
  return REWORK.has(status) ? withdrawMerge(db, card) : [];
}

const HANDLERS: Record<Exclude<OpName, "project.personal">, Handler> = {
  "maintenance.request": (db, session, raw, timing) =>
    requestMaintenance(db, session, check(OPS["maintenance.request"].args, raw), timing),
  "maintenance.status": (db, session, raw) =>
    maintenanceStatus(db, session, check(OPS["maintenance.status"].args, raw)),
  "maintenance.read": (db, session, raw) => ({
    value: readMaintenance(db, session, check(OPS["maintenance.read"].args, raw).id),
    notify: [],
  }),
  "maintenance.ack": (db, session, raw) =>
    acknowledgeMaintenance(db, session, check(OPS["maintenance.ack"].args, raw)),
  complain: (db, session, raw, timing) => ({
    value: { id: recordComplaint(db, session, check(OPS.complain.args, raw), timing.wall()) },
    notify: [],
  }),
  complaints: (db, session, raw) => ({
    value: listComplaints(db, session, check(OPS.complaints.args, raw)),
    notify: [],
  }),
  "close.begin": (db, session, raw, _timing, _note, closeCheck) =>
    closeBegin(db, session, raw, closeCheck),
  "close.finish": (db, session, raw, _timing, _note, closeCheck) =>
    closeFinish(db, session, raw, closeCheck),
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
  board: (db, session, _raw, timing) => ({
    value: boardFor(db, session.lane, timing),
    notify: [],
  }),
  card: (db, session, raw, timing) => {
    const { card } = check(OPS.card.args, raw);
    if (session.lane !== mainLane(db) && getCard(db, card).lane !== session.lane)
      throw new Error(`c-${String(card)} is in another lane; ask main`);
    return { value: cardView(db, card, session.lane, timing), notify: [] };
  },
  "project.yolo": (db, session, raw) => {
    if (session.lane !== mainLane(db))
      throw new Error("only main can change a project's yolo flag");
    const args = check(OPS["project.yolo"].args, raw);
    setYolo(db, args.project, args.on);
    return { value: args, notify: [] };
  },
  projects: (db) => ({ value: listProjects(db), notify: [] }),
  comment: (db, session, raw) => comment(db, session, raw),
  "lane.plan": (db, session, _raw, timing) => ({
    value: loadPlan(db, session.lane, timing.wall()),
    notify: [],
  }),
  wake: (db, session, raw) => {
    const entry = scriptWake(db, session.lane, check(OPS.wake.args, raw));
    return { value: { entry }, notify: [session.lane] };
  },
  "schedule.set": (db, session, raw, timing) => ({
    value: setSchedule(db, session.lane, raw, timing.wall()),
    notify: [],
  }),
  "schedule.list": (db, session) => ({ value: listSchedules(db, session.lane), notify: [] }),
  "schedule.remove": (db, session, raw) => {
    const { id } = check(OPS["schedule.remove"].args, raw);
    removeSchedule(db, session.lane, id);
    return { value: { id }, notify: [] };
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
      model: args.model,
    });
    return { value: begun, notify: [] };
  },
  "attempt.resume": (db, session, raw) => {
    const { card: id } = check(OPS["attempt.resume"].args, raw);
    const card = ownCard(db, session, id);
    requireOpen(db, card);
    const attempt = resumeAttempt(db, card);
    const generation = generationOf(db, attempt.session);
    return { value: { ...attempt, generation }, notify: [] };
  },
  "branch.name": (db, session, raw) => {
    const args = check(OPS["branch.name"].args, raw);
    return { value: nameBranch(db, session.id, args.name), notify: [] };
  },
  "replies.owed": (db, session) => ({
    value:
      session.card === null || ["done", "dropped"].includes(getCard(db, session.card).status)
        ? []
        : workerOwedIds(cardEntries(db, session.card)),
    notify: [],
  }),
  "hold.open": (db, session) => ({
    value: session.card !== null && holdOf(db, getCard(db, session.card)) !== undefined,
    notify: [],
  }),
  standing: (db, session) => {
    if (session.card === null) throw new Error("only a worker on a card has a standing");
    const { status, attention, until } = loadCard(db, session.card).standing;
    return { value: { status, attention, until }, notify: [] };
  },
  ...JOB_HANDLERS,
  "incident.report": (db, session, raw, timing) =>
    reportFailure(db, session, check(OPS["incident.report"].args, raw), timing),
  "incident.clear": (db, session, raw) =>
    clearFailure(db, session, check(OPS["incident.clear"].args, raw)),
  "lane.stopping": (db, session, raw, timing) => ({
    value: markStopping(
      db,
      session,
      check(OPS["lane.stopping"].args, raw),
      timing.wall(),
      timing.stop,
    ),
    notify: [],
  }),
  "card.restart": (db, session, raw, timing) =>
    restartCard(db, session, check(OPS["card.restart"].args, raw), timing),
  "card.restart.failed": (db, session, raw) =>
    restartFailed(db, session, check(OPS["card.restart.failed"].args, raw)),
  "card.restart.notice": (db, session, raw) =>
    restartNotice(db, session, check(OPS["card.restart.notice"].args, raw)),
  report: (db, session, raw, _timing, note, _closeCheck, emptyBranch) => {
    const { status, ...fieldsFromRequest } = check(OPS.report.args, raw);
    if (session.card === null) throw new Error("only a worker on a card can report");
    if (status === "stopped-if-idle" && hasJobWait(db, session.id))
      return { value: { ...getCard(db, session.card), deferred: true }, notify: [] };
    const args = {
      ...fieldsFromRequest,
      status: status === "stopped-if-idle" ? "stopped" : status,
    } satisfies { status: ReportStatus };
    requireDatedPause(args.status, args.until);
    requireCommentsRead(db, session.id, args.status);
    const card = openCardWithPr(db, session.card, args.pr);
    if (stopsNothing(db, card, args.status)) return { value: card, notify: [] };
    const unwatched = unwatchedPause(db, session, args.status);
    const to = reportRecipients(db, session, card, args, unwatched);
    const withdrawn =
      args.merged === true
        ? withdrawMerge(db, card, "merged")
        : rework(db, card, args.status, emptyBranch);
    const report: Draft = {
      card: card.id,
      author: `worker:${session.id}`,
      kind: "report",
      body: args.text,
      fields: reportFields(db, card, args, emptyBranch, note),
    };
    const merge = recordReport(db, card, args, report, to);
    const advice = unwatched ? { advice: NOTHING_RUNS } : {};
    const value = { ...getCard(db, card.id), ...advice };
    return { value, notify: [...to, ...withdrawn, ...merge] };
  },
};

type ReportArgs = Omit<OpArgs<"report">, "status"> & { status: ReportStatus };

function reportFields(
  db: DatabaseSync,
  card: Card,
  args: ReportArgs,
  emptyBranch: true | undefined,
  note: string | undefined,
): Record<string, unknown> {
  return {
    status: args.status,
    key: args.key,
    until: args.until,
    replyTo: args.replyTo,
    evidence: args.evidence,
    emptyBranch,
    ...landingOf(db, card, args, emptyBranch),
    ...(note === undefined ? {} : { prNote: note }),
  };
}

function recordReport(
  db: DatabaseSync,
  card: Card,
  args: ReportArgs,
  report: Draft,
  to: string[],
): string[] {
  const asked =
    args.status === "done" && args.merged !== true ? mergeQuestion(db, card, [report]) : undefined;
  const statusAfter = statusWith(db, card, asked === undefined ? [report] : [report, asked]);
  addEntry(db, { ...report, fields: { ...report.fields, statusAfter } }, to);
  return asked === undefined ? [] : writeMergeQuestion(db, card, asked);
}

function openCardWithPr(db: DatabaseSync, id: number, pr: string | undefined): Card {
  requireOpen(db, getCard(db, id));
  recordReportedPr(db, id, pr);
  return getCard(db, id);
}

function landingOf(
  db: DatabaseSync,
  card: Card,
  args: OpArgs<"report">,
  emptyBranch: true | undefined,
): LandingFields {
  if (args.merged === true) {
    if ((args.status !== "done" && args.status !== "merged") || card.pr === null)
      throw new Error("a merged report must be done and name its PR URL");
    return { merged: true, pr: card.pr };
  }
  if (args.status !== "done" || card.kind !== "ship") return {};
  if (card.delivery === "ops") return { landing: "operation: no PR expected" };
  if (card.delivery === "local-only") return localLandingFields(db, card, emptyBranch);
  if (card.pr !== null) return { pr: card.pr };
  return { prNote: "no PR URL reported: the worker reports it with report(pr=<full url>)" };
}

function localLandingFields(
  db: DatabaseSync,
  card: Card,
  emptyBranch: true | undefined,
): LandingFields {
  if (emptyBranch === true) return { landing: "local-only: the branch is empty, so nothing lands" };
  const local = localLanding(db, card.id);
  if (local === undefined) return { landing: "local-only: the card has no branch" };
  return {
    landing: `local-only: branch ${local.branch} lands on local ${local.base} when the card closes`,
  };
}

export async function performOp(
  db: DatabaseSync,
  session: Session,
  op: OpName,
  args: unknown,
  timing: Timings,
  hosts: Hosts,
): Promise<Done> {
  const roles: readonly string[] = OPS[op].roles;
  if (!roles.includes(session.role)) throw new Error(`${session.role} sessions cannot call ${op}`);
  return keepingRefusals(db, () => performStored(db, session, op, args, timing, hosts));
}

async function performStored(
  db: DatabaseSync,
  session: Session,
  op: OpName,
  args: unknown,
  timing: Timings,
  hosts: Hosts,
): Promise<Done> {
  if (op === "project.personal") {
    await ensurePersonalProject(db, session, hosts, args);
    return { value: true, notify: [] };
  }
  const report =
    op === "report" && session.card !== null
      ? await normalizeReport(db, hosts, session.card, args)
      : undefined;
  const emptyBranch =
    op === "report" && session.card !== null
      ? await emptyLocalBranch(db, hosts, session.card, report?.args ?? args)
      : undefined;
  const closeCheck =
    op === "close.begin" || op === "close.finish"
      ? await reverifyAtClose(db, hosts, op, args)
      : undefined;
  return transaction(db, () => {
    const result = HANDLERS[op](
      db,
      session,
      report?.args ?? args,
      timing,
      report?.note,
      closeCheck,
      emptyBranch,
    );
    noteControl(db, session.id, op);
    return result;
  });
}
