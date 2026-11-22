import type { DatabaseSync } from "node:sqlite";
import { check, OPS } from "@fleet/protocol";
import { jobCutover } from "./job-cutover.ts";
import {
  dropLostJob,
  finishJob,
  hasJobWait,
  prepareJob,
  recordJobResult,
  registerJob,
  isJobRunning,
  runningJobs,
  startJob,
  stopJob,
  touchJob,
} from "./jobs.ts";
import { requireReviewDecision } from "./reviews.ts";
import { addEntry, mainLane, type Session } from "./store.ts";
import type { Timings } from "./timing.ts";

type JobHandler = (
  db: DatabaseSync,
  session: Session,
  args: unknown,
  timing: Timings,
) => { readonly value: unknown; readonly notify: readonly string[] };

export const JOB_HANDLERS = {
  "job.start": (db, session, raw, timing) => {
    const args = check(OPS["job.start"].args, raw);
    requireReviewDecision(db, session, args.command);
    const job = startJob(db, session.id, { label: args.label, command: args.command });
    return { value: { job, heartbeatMs: timing.heartbeat }, notify: [] };
  },
  "job.prepare": (db, session, raw, timing) => {
    const args = check(OPS["job.prepare"].args, raw);
    requireReviewDecision(db, session, args.command);
    return { value: prepareJob(db, session.id, args, timing.heartbeat), notify: [] };
  },
  "job.register": (db, session, raw) => ({
    value: { registered: registerJob(db, session.id, check(OPS["job.register"].args, raw)) },
    notify: [],
  }),
  "job.cutover": (db, session, raw) => {
    if (session.lane !== mainLane(db)) throw new Error("only main can control job cutover");
    return { value: jobCutover(db, check(OPS["job.cutover"].args, raw)), notify: [] };
  },
  "job.alive": (db, session, raw) => {
    const args = check(OPS["job.alive"].args, raw);
    const { running, revived } = touchJob(db, session.id, args.job);
    if (revived === undefined || session.card === null) return { value: { running }, notify: [] };
    const fields = { job: args.job, label: revived.label, revived: true };
    const body = "its process is alive again, so it is running again.";
    const entry = {
      card: session.card,
      author: `job:${String(args.job)}`,
      kind: "job-result",
      body,
      fields,
    };
    addEntry(db, entry, [session.id]);
    return { value: { running }, notify: [session.id] };
  },
  "job.finish": (db, session, raw) => {
    const args = check(OPS["job.finish"].args, raw);
    const finished = finishJob(db, session.id, {
      id: args.job,
      exitCode: args.exitCode,
      outputTail: args.outputTail,
      ...(args.beforeRegistration === undefined
        ? {}
        : { beforeRegistration: args.beforeRegistration }),
    });
    if (finished === undefined || session.card === null)
      return { value: { recorded: false }, notify: [] };
    return {
      value: { recorded: true },
      notify: recordJobResult(db, session, args.job, finished.label, args, finished.fencedLaunch),
    };
  },
  "job.stop": (db, session, raw) => {
    const args = check(OPS["job.stop"].args, raw);
    const { label, running, result, launch } = stopJob(db, session.id, args.job);
    if (result === undefined) return { value: { label, running }, notify: [] };
    return {
      value: { label, running, cancelled: true },
      notify: recordJobResult(db, session, args.job, label, result, launch),
    };
  },
  "job.drop": (db, session, raw) => {
    const args = check(OPS["job.drop"].args, raw);
    const owner = session.role === "mate" ? { lane: session.lane } : { session: session.id };
    const dropped = dropLostJob(db, args.job, owner);
    if (dropped === undefined)
      throw new Error(`job ${String(args.job)} is not one of yours: nothing was dropped`);
    return { value: dropped, notify: [] };
  },
  "job.idle": (db, session) => ({ value: { idle: !hasJobWait(db, session.id) }, notify: [] }),
  "job.running": (db, session, raw) => {
    const { job } = check(OPS["job.running"].args, raw);
    return { value: { running: isJobRunning(db, session.id, job) }, notify: [] };
  },
  jobs: (db, session) => ({ value: runningJobs(db, session.id), notify: [] }),
} satisfies Record<string, JobHandler>;
