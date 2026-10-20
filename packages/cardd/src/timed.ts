// The timed check (spec section 13): one pass over cards.db that finds what no
// event reported. It writes each finding once and wakes nobody when all is well.
import type { DatabaseSync } from "node:sqlite";
import { loseSilentJobs } from "./attempts.ts";
import { addEntry, getCard, setStatus } from "./store.ts";

const HEARTBEAT_MS = 30_000;
const CHECK_MS = 60_000;
const MISSED_HEARTBEATS = 3;

export interface Timing {
  /** How often a run_long wrapper tells cardd that it is alive. */
  readonly heartbeatMs: number;
  /** How often the timed check runs. */
  readonly checkMs: number;
}

/** The timers, with every interval multiplied by `scale`. Tests use a small scale. */
export function timingFor(scale: number): Timing {
  return {
    heartbeatMs: Math.max(1, Math.round(HEARTBEAT_MS * scale)),
    checkMs: Math.max(1, Math.round(CHECK_MS * scale)),
  };
}

/** A running job whose wrapper stopped sending heartbeats is lost: the lane mate decides what next. Returns the sessions with new entries. */
export function timedCheck(db: DatabaseSync, timing: Timing, now: number): string[] {
  const lost = loseSilentJobs(db, now - MISSED_HEARTBEATS * timing.heartbeatMs);
  return lost.map((job) => {
    const card = getCard(db, job.card);
    const body = `job lost: job ${String(job.id)} (${job.label}) stopped reporting. It is not run again.`;
    const fields = { condition: "job lost", job: job.id };
    addEntry(db, { card: card.id, author: "check", kind: "finding", body, fields }, [card.lane]);
    if (card.status === "working" || card.status === "in-review")
      setStatus(db, card.id, "with-mate");
    return card.lane;
  });
}
