import type { DatabaseSync } from "node:sqlite";
import { check, OPS, type OpArgs, type OpResult } from "@fleet/protocol";

const BLOCKERS = `
  SELECT j.id AS job, a.card, a.host, j.label, j.state
  FROM jobs j JOIN attempts a ON a.id = j.attempt
  LEFT JOIN job_stop_confirmations s ON j.id = s.job
  WHERE j.launch_id IS NULL AND (j.state = 'running' OR s.job IS NULL)`;

function confirmStop(db: DatabaseSync, job: number, evidence: string): void {
  if (evidence.trim() === "")
    throw new Error("Give the evidence that the legacy job's process tree cannot run");
  const blocker = db.prepare(`${BLOCKERS} AND j.id = ?`).get(job);
  if (blocker === undefined) throw new Error("That job is not a legacy cutover blocker");
  if (blocker["state"] === "running")
    throw new Error(
      "The job is still recorded as running; stop it and wait for its state to change",
    );
  db.prepare(
    "INSERT INTO job_stop_confirmations (job, confirmed_at, evidence) VALUES (?, ?, ?)",
  ).run(job, Date.now(), evidence);
}

export function jobCutover(db: DatabaseSync, args: OpArgs<"job.cutover">): OpResult<"job.cutover"> {
  if (args.action === "seal")
    db.prepare("INSERT OR IGNORE INTO job_cutover (id, sealed_at) VALUES (1, ?)").run(Date.now());
  const sealed = db.prepare("SELECT id FROM job_cutover").get() !== undefined;
  if (args.action === "confirm-stop") {
    if (!sealed) throw new Error("Seal legacy job launches before recording a stop");
    confirmStop(db, args.job, args.evidence);
  }
  const blockers = db.prepare(`${BLOCKERS} ORDER BY j.id`).all();
  return check(OPS["job.cutover"].result, {
    state: !sealed ? "open" : blockers.length > 0 ? "draining" : "ready",
    blockers,
  });
}
