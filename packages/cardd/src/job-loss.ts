import type { DatabaseSync } from "node:sqlite";
import { loseGoneJobs } from "./job-presence.ts";
import { loseSilentLegacyJobs, type LostJob } from "./jobs.ts";
import type { Hosts } from "./pulls.ts";
import { addEntry, getCard, workerOf } from "./store.ts";
import type { Timings } from "./timing.ts";

export const MISSED_HEARTBEATS = 3;

export interface JobLossGrace {
  firstCheckAt?: number;
  until: number;
}

function jobLossHeld(grace: JobLossGrace, now: number, heartbeat: number): boolean {
  const started = grace.firstCheckAt;
  if (started === undefined) return true;
  return now - started < MISSED_HEARTBEATS * heartbeat || now < grace.until;
}

interface LossWords {
  readonly finding: string;
  readonly note: string;
}

const SILENT: LossWords = {
  finding: "stopped reporting. It is not run again.",
  note: "no heartbeat arrived. It is not run again.",
};
const GONE: LossWords = {
  finding: "its wrapper process is gone. It is not run again.",
  note: "its wrapper process is gone. It is not run again.",
};

function announceLost(db: DatabaseSync, lost: readonly LostJob[], words: LossWords): string[] {
  return lost.flatMap((job) => {
    const card = getCard(db, job.card);
    const body = `job lost: job ${String(job.id)} (${job.label}) ${words.finding}`;
    addEntry(
      db,
      {
        card: card.id,
        author: "check",
        kind: "finding",
        body,
        fields: { condition: "job-lost", job: job.id },
      },
      [card.lane],
    );
    const worker = workerOf(db, card.id);
    if (worker === undefined) return [card.lane];
    const fields = { job: job.id, label: job.label, lost: true };
    addEntry(
      db,
      {
        card: card.id,
        author: `job:${String(job.id)}`,
        kind: "job-result",
        body: words.note,
        fields,
      },
      [worker],
    );
    return [card.lane, worker];
  });
}

export function lostJobs(db: DatabaseSync, now: number, t: Timings, grace: JobLossGrace): string[] {
  if (jobLossHeld(grace, now, t.heartbeat)) return [];
  const lost = loseSilentLegacyJobs(db, now - MISSED_HEARTBEATS * t.heartbeat);
  return announceLost(db, lost, SILENT);
}

export function goneJobs(
  db: DatabaseSync,
  hosts: Hosts,
  now: number,
  t: Timings,
  grace: JobLossGrace,
): Promise<string[]> {
  if (jobLossHeld(grace, now, t.heartbeat)) return Promise.resolve([]);
  return loseGoneJobs(db, hosts, now - MISSED_HEARTBEATS * t.heartbeat, (lost) =>
    announceLost(db, lost, GONE),
  );
}
