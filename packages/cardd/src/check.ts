import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { quietSql } from "./attempts.ts";
import { jobStateSql, loseSilentJobs } from "./jobs.ts";
import { chaseIntake, dueBatches, remind } from "./deliveries.ts";
import { escalationText, told, UNRECOVERABLE, unrecoverable } from "./incident-escalation.ts";
import { liveStateSql } from "./incident-lifecycle.ts";
import { LIVE_INCIDENT } from "./incident-store.ts";
import { lostMates } from "./incident-lanes.ts";
import { expireMaintenance } from "./maintenance.ts";
import { reconcileIncidents, watchdogIncident } from "./incidents.ts";
import { describe, labelOf } from "./incident-text.ts";
import { incidentFrom } from "./incident-store.ts";
import { replyNudges } from "./replies.ts";
import { finishedOpen, idleNow, resting } from "./status.ts";
import { addEntry, getCard, loadOpenCards, mainLane, workerOf, type Loaded } from "./store.ts";
import { type Timings } from "./timing.ts";
import { actingLane, bundleMatches, minutesSince } from "./bundle.ts";
import { firedSchedules } from "./schedules.ts";
import { scheduledWakes } from "./wakes.ts";

interface Match {
  readonly card: number;
  readonly lane: string;
  readonly condition: string;
  readonly text: string;
  readonly tier: number;
  readonly to?: string;
  readonly instance?: string;
  readonly worker?: boolean;
  readonly fields?: Record<string, unknown>;
}

const keyOf = (match: Match): string =>
  `${match.condition}${match.instance === undefined ? "" : `:${match.instance}`}#${String(match.tier)}`;

const workerCards = (
  ids: readonly number[],
): string => `SELECT c.id AS card, c.lane AS lane, a.id AS attemptId, a.state AS attempt, a.created_at AS started,
    s.state AS state, s.last_seen AS seen, coalesce(c.last_activity, s.last_seen, 0) AS active, s.id AS session,
    max(coalesce(s.turn_since, 0), coalesce(s.progress_at, 0),
      coalesce((SELECT max(created_at) FROM entries WHERE card = c.id AND author LIKE 'worker:%'), 0)) AS productive
  FROM cards c JOIN attempts a ON a.card = c.id AND a.state IN ('starting', 'active')
  JOIN sessions s ON s.attempt = a.id
  WHERE c.id IN (${ids.map(Number).join(", ")})`;

const WORKER_RULES: readonly {
  condition: string;
  text: string;
  where: (t: Timings) => string;
  since: string;
  first: (t: Timings) => number;
}[] = [
  {
    condition: "worker-never-connected",
    text: "worker never connected",
    where: () => "w.attempt = 'starting'",
    since: "w.started",
    first: (t) => t.neverConnected,
  },
  {
    condition: "worker-not-connected",
    text: "worker not connected",
    where: () => "w.attempt = 'active' AND w.state IN ('exited', 'lost')",
    since: "w.seen",
    first: (t) => t.notConnected,
  },
  {
    condition: "worker-stalled",
    text: "worker stalled",
    where: () => "w.state = 'running'",
    since: "w.active",
    first: (t) => t.stall,
  },
  {
    condition: "worker-spinning",
    text: "worker spinning: one long turn with no report, commit, or file change",
    where: (t) => `w.state = 'running' AND ?1 - w.active <= ${String(t.stall)}`,
    since: "w.productive",
    first: (t) => t.spin,
  },
];

const IDLE_WORKERS = (
  ids: readonly number[],
): string => `SELECT w.card AS card, w.lane AS lane, w.seen AS seen,
    coalesce((SELECT max(created_at) FROM entries WHERE card = w.card AND author LIKE 'worker:%'), 0) AS spoke,
    (SELECT max(created_at) FROM entries WHERE card = w.card AND author = 'check'
      AND json_extract(fields, '$.condition') = 'worker-idle-nudge') AS nudged,
    (SELECT min(created_at) FROM entries WHERE card = w.card AND author = 'check'
      AND json_extract(fields, '$.condition') = 'worker-idle-nudge'
      AND created_at > coalesce((SELECT max(created_at) FROM entries
        WHERE card = w.card AND author LIKE 'worker:%'), 0)) AS ignored
  FROM (${workerCards(ids)}) w
  WHERE ${quietSql("w.state", "w.attemptId")}
    AND NOT ${LIVE_INCIDENT.replace("SESSION", "w.session")}
    AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.session = w.session AND d.state IN ('pending', 'pushed'))`;

const NUDGE_TEXT =
  "you went idle without reporting. If the work is done or you are stuck, call report now with the right status. If you are still working, carry on and report when you reach a handoff.";

const repeatTier = (waited: number, first: number, every: number): number =>
  waited < first ? 0 : 1 + Math.floor((waited - first) / every);

function rows(
  db: DatabaseSync,
  sql: string,
  ...params: SQLInputValue[]
): Record<string, unknown>[] {
  return db.prepare(sql).all(...params);
}

function workerMatches(
  db: DatabaseSync,
  open: readonly Loaded[],
  now: number,
  t: Timings,
): Match[] {
  const ids = open.filter(({ standing }) => resting(standing)).map(({ card }) => card.id);
  if (ids.length === 0) return [];
  const running = WORKER_RULES.flatMap(({ condition, text, where, since, first }) =>
    rows(
      db,
      `SELECT w.card AS card, w.lane AS lane, ${since} AS since FROM (${workerCards(ids)}) w WHERE ${where(t)} AND ?1 >= ${since}`,
      now,
    ).flatMap((row) => {
      const tier = repeatTier(now - Number(row["since"]), first(t), t.repeat);
      return tier === 0
        ? []
        : [{ card: Number(row["card"]), lane: String(row["lane"]), condition, text, tier }];
    }),
  );
  const idleIds = open.filter(({ standing }) => idleNow(standing, now)).map(({ card }) => card.id);
  return [...running, ...idleMatches(db, idleIds, now, t)];
}

function idleMatches(db: DatabaseSync, ids: readonly number[], now: number, t: Timings): Match[] {
  if (ids.length === 0) return [];
  return rows(db, IDLE_WORKERS(ids)).flatMap((row): Match[] => {
    const card = Number(row["card"]);
    const lane = String(row["lane"]);
    const seen = Number(row["seen"]);
    const nudged = typeof row["nudged"] === "number" ? row["nudged"] : 0;
    const ignored = typeof row["ignored"] === "number" ? row["ignored"] : undefined;
    const settled = now - seen >= t.idleNudge;
    const nudge: Match[] =
      settled && (ignored === undefined || nudged < seen)
        ? [
            {
              card,
              lane,
              condition: "worker-idle-nudge",
              text: `reminder: ${NUDGE_TEXT}`,
              tier: 1,
              instance: String(seen),
              worker: true,
            },
          ]
        : [];
    const tier =
      ignored === undefined || !settled ? 0 : repeatTier(now - ignored, t.idleTell, t.repeat);
    const text = "worker idle without a handoff, and it did not act on a nudge";
    return [
      ...nudge,
      ...(tier === 0 ? [] : [{ card, lane, condition: "worker-idle", text, tier }]),
    ];
  });
}

const PROCESS_PHASES: Readonly<Record<string, "startup" | "lost">> = {
  "worker-never-connected": "startup",
  "worker-not-connected": "lost",
};

function withIncidents(
  db: DatabaseSync,
  matches: readonly Match[],
  now: number,
  t: Timings,
): Match[] {
  return matches.map((match) => {
    const phase = PROCESS_PHASES[match.condition];
    if (phase === undefined) return match;
    const found = watchdogIncident(db, match.card, phase, now, t);
    return found === undefined ? match : { ...match, text: `${match.text}. ${found}` };
  });
}

function closeAdvice(kind: string, merged: boolean, hasPr: boolean, delivery: unknown): string {
  if (merged) return "Close it now with close(card, summary).";
  if (kind === "ship" && delivery === "local-only")
    return "Its branch lands on the local base branch when you close it: once the landing is authorized (yolo on, or the captain's word for it), close(card, summary). If it will not land, close(card, summary=<why>, landed=false).";
  if (kind !== "ship")
    return "Relay the findings, then close it with close(card, summary), or close(card, summary=<why>, landed=false) if it did not land.";
  if (hasPr)
    return "Once the merge is authorized (yolo on with green checks, or the captain's word for this PR), comment the worker to merge its PR and report it merged, then close(card, summary). If it will not land, close(card, summary=<why>, landed=false).";
  return "Its work may have landed from another branch. Close it with close(card, summary): if close warns about commits or files not on the base branch and the work landed elsewhere, call close again with confirm=true. If it never landed and will not, close(card, summary=<why>, landed=false).";
}

const UP: ReadonlySet<unknown> = new Set(["starting", "idle", "running", "waiting"]);

const mateState = (db: DatabaseSync, lane: string | null): unknown =>
  lane === null
    ? undefined
    : db.prepare("SELECT state FROM sessions WHERE id = ? AND role = 'mate'").get(lane)?.["state"];

const isUp = (db: DatabaseSync, lane: string): boolean => UP.has(mateState(db, lane));

function finishedMatches(
  card: {
    id: number;
    lane: string;
    kind: string;
    pr: unknown;
    delivery: unknown;
    status: string;
    since: number;
  },
  finish: { merged: boolean; at: number },
  now: number,
  t: Timings,
): Match[] {
  const since = Math.max(card.since, finish.at);
  const tier = repeatTier(now - since, t.finished, t.finished);
  if (tier === 0) return [];
  const close = closeAdvice(card.kind, finish.merged, card.pr !== null, card.delivery);
  const waited = `${card.status}, ${String(minutesSince(now, since))} min`;
  const text = `reminder: c-${String(card.id)} is finished and still open (${waited}). ${close}`;
  return [{ card: card.id, lane: card.lane, condition: "finished", text, tier }];
}

function finishedCards(open: readonly Loaded[], t: Timings): Match[] {
  return open.flatMap(({ card: own, entries, standing }) => {
    if (own.status !== "with-mate" && own.status !== "merging") return [];
    const { hold } = standing.facts;
    const finish = finishedOpen(entries);
    if (hold !== undefined || finish === undefined) return [];
    return finishedMatches({ ...own, since: standing.since }, finish, t.wall(), t);
  });
}

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

function lostJobs(db: DatabaseSync, now: number, t: Timings, grace: JobLossGrace): string[] {
  if (jobLossHeld(grace, now, t.heartbeat)) return [];
  return loseSilentJobs(db, now - MISSED_HEARTBEATS * t.heartbeat).flatMap((job) => {
    const card = getCard(db, job.card);
    const body = `job lost: job ${String(job.id)} (${job.label}) stopped reporting. It is not run again.`;
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
    const heard = worker === undefined ? [] : [worker];
    if (worker !== undefined) {
      const fields = { job: job.id, label: job.label, lost: true };
      const note = "no heartbeat arrived. It is not run again.";
      addEntry(
        db,
        { card: card.id, author: `job:${String(job.id)}`, kind: "job-result", body: note, fields },
        heard,
      );
    }
    return worker === undefined ? [card.lane] : [card.lane, worker];
  });
}

function lostJobMatches(db: DatabaseSync, now: number, t: Timings): Match[] {
  return rows(
    db,
    `SELECT j.id AS id, j.label AS label, j.updated_at AS since, a.card AS card, c.lane AS lane
     FROM jobs j JOIN attempts a ON a.id = j.attempt JOIN cards c ON c.id = a.card
     WHERE ${jobStateSql("j.state", "lost")} AND j.dropped_at IS NULL AND a.state IN ('starting', 'active')
       AND NOT EXISTS (SELECT 1 FROM jobs later
         WHERE later.attempt = j.attempt AND later.label = j.label AND later.id > j.id)
     ORDER BY j.id`,
  ).flatMap((row) => {
    const tier = repeatTier(now - Number(row["since"]), t.repeat, t.repeat);
    if (tier === 0) return [];
    const id = String(row["id"]);
    const text = `reminder: job ${id} (${String(row["label"])}) is still lost. It is not run again: ask the worker to run it again, or to drop it with drop_job(job).`;
    return [
      {
        card: Number(row["card"]),
        lane: String(row["lane"]),
        condition: "job-lost-open",
        instance: id,
        text,
        tier,
      },
    ];
  });
}

function incidentMatches(db: DatabaseSync, now: number, t: Timings): Match[] {
  return rows(
    db,
    `SELECT * FROM incidents WHERE state IN (${liveStateSql()}) AND parent IS NOT NULL AND phase IN ('turn', 'compaction')`,
  )
    .map(incidentFrom)
    .flatMap((inc) => {
      const tier = repeatTier(now - inc.firstAt, t.repeat, t.repeat);
      if (inc.parent === null || tier === 0) return [];
      const role = db.prepare("SELECT role FROM sessions WHERE id = ?").get(inc.actor)?.["role"];
      const text = `reminder: ${describe(inc, labelOf(inc, role === "mate" ? "mate" : "worker"))}`;
      return [
        {
          card: inc.card,
          lane: inc.parent,
          condition: "runtime-failure-open",
          instance: String(inc.id),
          text,
          tier,
        },
      ];
    });
}

const findingOpen = (db: DatabaseSync, card: number, key: string): boolean =>
  db
    .prepare("SELECT 1 FROM findings WHERE card = ? AND condition = ? AND cleared_at IS NULL")
    .get(card, key) !== undefined;

function escalationMatches(db: DatabaseSync, now: number, t: Timings): Match[] {
  return unrecoverable(db).flatMap((stuck) => {
    const { incident, lane } = stuck;
    if (repeatTier(now - incident.firstAt, t.repeat, t.repeat) === 0) return [];
    const match: Match = {
      card: incident.card,
      lane,
      to: mainLane(db),
      condition: UNRECOVERABLE,
      instance: String(incident.id),
      text: escalationText(stuck, t.wall()),
      tier: 1,
      fields: { incident: incident.id },
    };
    return told(db, incident) && !findingOpen(db, match.card, keyOf(match)) ? [] : [match];
  });
}

function holdMatches(db: DatabaseSync, open: readonly Loaded[], now: number): Match[] {
  return open.flatMap(({ card, standing }) => {
    const { hold } = standing.facts;
    const until = hold?.until ?? null;
    if (hold === undefined || until === null || until > now || standing.status === "waiting")
      return [];
    return [
      {
        card: card.id,
        lane: actingLane(db, card.id, card.lane),
        condition: `hold-ended:${String(until)}`,
        text: `hold ended; it waits on ${hold.holder === "owner" ? "its mate" : hold.holder} again`,
        tier: 1,
      },
    ];
  });
}

function clearStopped(db: DatabaseSync, now: number, matches: readonly Match[]): void {
  const live = new Set(matches.map((match) => `${String(match.card)}/${keyOf(match)}`));
  for (const open of rows(
    db,
    "SELECT id, card, condition FROM findings WHERE cleared_at IS NULL",
  )) {
    if (live.has(`${String(open["card"])}/${String(open["condition"])}`)) continue;
    db.prepare(
      `DELETE FROM deliveries WHERE entry IN (
      SELECT id FROM entries WHERE card = ? AND author = 'check' AND json_extract(fields, '$.finding') = ?)`,
    ).run(Number(open["card"]), String(open["condition"]));
    db.prepare("UPDATE findings SET cleared_at = ? WHERE id = ?").run(now, Number(open["id"]));
  }
}

function recipientOf(db: DatabaseSync, match: Match): string | undefined {
  return match.worker === true ? workerOf(db, match.card) : (match.to ?? match.lane);
}

function writeFindings(
  db: DatabaseSync,
  now: number,
  matches: readonly Match[],
  notify: Set<string>,
): void {
  for (const match of matches) {
    const key = keyOf(match);
    const to = recipientOf(db, match);
    if (findingOpen(db, match.card, key) || to === undefined) continue;
    if (match.worker !== true && !isUp(db, to)) continue;
    const fields = {
      ...match.fields,
      condition: match.condition,
      tier: match.tier,
      finding: key,
    };
    remind(
      db,
      { card: match.card, author: "check", kind: "finding", body: match.text, fields },
      [to],
      `${match.condition}:${match.instance ?? ""}`,
    );
    db.prepare("INSERT INTO findings (card, condition, opened_at) VALUES (?, ?, ?)").run(
      match.card,
      key,
      now,
    );
    notify.add(to);
  }
}

export function runCheck(db: DatabaseSync, now: number, t: Timings, grace: JobLossGrace): string[] {
  const open = loadOpenCards(db);
  const acting = new Set(
    open
      .filter(({ standing }) => standing.status !== "waiting" && standing.status !== "paused")
      .map(({ card }) => card.id),
  );
  const matches = [
    ...withIncidents(db, workerMatches(db, open, now, t), now, t),
    ...finishedCards(open, t),
    ...bundleMatches(db, open, now, t),
    ...lostJobMatches(db, now, t),
    ...incidentMatches(db, now, t),
    ...escalationMatches(db, now, t),
    ...holdMatches(db, open, now),
  ].filter((match) => acting.has(match.card));
  clearStopped(db, now, matches);
  const notify = new Set<string>([
    ...lostJobs(db, now, t, grace),
    ...chaseIntake(db, now, t),
    ...scheduledWakes(db, t.wall()),
    ...firedSchedules(db, t.wall()),
    ...dueBatches(db, { now: t.wall(), window: t.batch }),
    ...reconcileIncidents(db, now, t),
    ...lostMates(db, now, t),
    ...expireMaintenance(db, now, t),
    ...replyNudges(db, open, now, t),
  ]);
  writeFindings(db, now, matches, notify);
  return [...notify];
}
