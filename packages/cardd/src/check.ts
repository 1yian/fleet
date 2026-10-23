import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { loseSilentJobs, quietSql } from "./attempts.ts";
import { chaseIntake, dueBatches, remind } from "./deliveries.ts";
import { LIVE_INCIDENT } from "./incident-store.ts";
import { lostMates } from "./incident-lanes.ts";
import { expireMaintenance } from "./maintenance.ts";
import { reconcileIncidents, watchdogIncident } from "./incidents.ts";
import { describe, labelOf } from "./incident-text.ts";
import { incidentFrom } from "./incident-store.ts";
import { replyNudges } from "./replies.ts";
import { factsFrom, finishFrom, type Stage } from "./status.ts";
import {
  addEntry,
  cardEntries,
  getCard,
  loadCards,
  mainLane,
  parentOf,
  workerOf,
} from "./store.ts";
import { MINUTE, type Timings } from "./timing.ts";
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
}

const keyOf = (match: Match): string =>
  `${match.condition}${match.instance === undefined ? "" : `:${match.instance}`}#${String(match.tier)}`;

const WORKING: ReadonlySet<Stage> = new Set(["working", "in-review"]);

const workerCards = (
  ids: readonly number[],
): string => `SELECT c.id AS card, c.lane AS lane, a.id AS attemptId, a.state AS attempt, a.created_at AS started,
    s.state AS state, s.last_seen AS seen, coalesce(c.last_activity, s.last_seen, 0) AS active, s.id AS session,
    max(coalesce(s.turn_since, 0), coalesce(s.progress_at, 0),
      coalesce((SELECT max(created_at) FROM entries WHERE card = c.id AND author LIKE 'worker:%'), 0)) AS productive
  FROM cards c JOIN attempts a ON a.card = c.id AND a.state IN ('starting', 'active')
  JOIN sessions s ON s.attempt = a.id
  WHERE c.id IN (${ids.map(Number).join(", ")})`;

const LATEST_REPORT = `(SELECT fields FROM entries WHERE card = w.card AND kind = 'report' ORDER BY id DESC LIMIT 1)`;

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
      AND json_extract(fields, '$.condition') = 'worker-idle-nudge') AS nudged
  FROM (${workerCards(ids)}) w
  WHERE ${quietSql("w.state", "w.attemptId")}
    AND NOT ${LIVE_INCIDENT.replace("SESSION", "w.session")}
    AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.session = w.session AND d.state IN ('pending', 'pushed'))
    AND NOT (coalesce(json_extract(${LATEST_REPORT}, '$.status'), '') = 'paused'
      AND coalesce(json_extract(${LATEST_REPORT}, '$.until'), 0) > ?1)`;

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

function workerMatches(db: DatabaseSync, now: number, t: Timings): Match[] {
  const ids = loadCards(db)
    .filter(({ standing }) => WORKING.has(standing.stage))
    .map(({ card }) => card.id);
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
  const idle = rows(db, IDLE_WORKERS(ids), now).flatMap((row): Match[] => {
    const card = Number(row["card"]);
    const lane = String(row["lane"]);
    const nudged = typeof row["nudged"] === "number" ? row["nudged"] : 0;
    if (nudged <= Number(row["spoke"]) || nudged < Number(row["seen"])) {
      if (now - Number(row["seen"]) < t.idleNudge) return [];
      const text = `reminder: ${NUDGE_TEXT}`;
      return [
        {
          card,
          lane,
          condition: "worker-idle-nudge",
          text,
          tier: 1,
          instance: String(row["seen"]),
          worker: true,
        },
      ];
    }
    const tier = repeatTier(now - nudged, t.idleTell, t.repeat);
    const text = "worker idle without a handoff, and it did not act on a nudge";
    return tier === 0 ? [] : [{ card, lane, condition: "worker-idle", text, tier }];
  });
  return [...running, ...idle];
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

function actingLane(db: DatabaseSync, card: number, lane: string): string {
  const { hold } = factsFrom(cardEntries(db, card));
  return hold?.holder === "main" ? (parentOf(db, lane) ?? lane) : lane;
}

function closeAdvice(kind: string, merged: boolean, hasPr: boolean, delivery: unknown): string {
  if (merged) return "Close it now with close(card, summary).";
  if (kind === "ship" && delivery === "local-only")
    return "Its branch lands on the local base branch when you close it: once the landing is authorized (yolo on, or the captain's word for it), close(card, summary). If it will not land, close(card, summary=<why>, landed=false).";
  if (kind !== "ship")
    return "Relay the findings, then close it with close(card, summary), or close(card, summary=<why>, landed=false) if it did not land.";
  if (hasPr)
    return "Once the merge is authorized (yolo on with green checks, or the captain's word for this PR), comment the worker to merge its PR and report it merged, then close(card, summary). If it will not land, close(card, summary=<why>, landed=false).";
  return "The worker has not reported a PR: comment it to report its PR URL. If it made no code change, close it with close(card, summary). Otherwise close(card, summary=<why>, landed=false).";
}

const minutesSince = (now: number, since: number): number => Math.round((now - since) / MINUTE);
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
  const tier = repeatTier(now - since, t.repeat, t.repeat);
  if (tier === 0) return [];
  const close = closeAdvice(card.kind, finish.merged, card.pr !== null, card.delivery);
  const waited = `${card.status}, ${String(minutesSince(now, since))} min`;
  const text = `reminder: c-${String(card.id)} is finished and still open (${waited}). ${close}`;
  return [{ card: card.id, lane: card.lane, condition: "finished", text, tier }];
}

function reminderMatches(db: DatabaseSync, now: number, t: Timings): Match[] {
  return loadCards(db).flatMap(({ card: own, entries, standing }) => {
    if (own.status !== "with-mate" && own.status !== "merging") return [];
    const card = own.id;
    const { hold } = standing.facts;
    const finish = finishFrom(entries);
    if (hold === undefined && (finish.merged || finish.workerDone)) {
      return finishedMatches({ ...own, since: standing.since }, finish, now, t);
    }
    const lane = actingLane(db, card, own.lane);
    const tier = repeatTier(now - standing.since, t.waiting, t.waiting);
    if (tier === 0) return [];
    const text = `reminder: this card has waited for you (${own.status}, ${String(minutesSince(now, standing.since))} min)`;
    return [{ card, lane, condition: "reminder", text, tier }];
  });
}

function decisionMatches(db: DatabaseSync, now: number, t: Timings): Match[] {
  return loadCards(db)
    .filter(({ standing }) => standing.status === "needs-you")
    .sort((a, b) => a.standing.since - b.standing.since)
    .flatMap(({ card, standing }) => {
      const tier = repeatTier(now - standing.since, t.decision, t.decision);
      if (tier === 0) return [];
      const main = mainLane(db);
      const hours = String(Math.round((now - standing.since) / (60 * MINUTE)));
      const question = firstLine(standing.facts.hold?.question ?? "");
      const text = `reminder: c-${String(card.id)} has waited ${hours} h for the captain's decision: ${question}`;
      return [
        {
          card: card.id,
          lane: main,
          condition: "decision-waiting",
          text,
          tier,
        },
      ];
    });
}

const firstLine = (text: string): string =>
  text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line !== "") ?? "";

const MISSED_HEARTBEATS = 3;

function lostJobs(db: DatabaseSync, now: number, t: Timings): string[] {
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
     WHERE j.state = 'lost' AND a.state IN ('starting', 'active')
       AND NOT EXISTS (SELECT 1 FROM jobs later
         WHERE later.attempt = j.attempt AND later.label = j.label AND later.id > j.id)
     ORDER BY j.id`,
  ).flatMap((row) => {
    const tier = repeatTier(now - Number(row["since"]), t.repeat, t.repeat);
    if (tier === 0) return [];
    const id = String(row["id"]);
    const text = `reminder: job ${id} (${String(row["label"])}) is still lost. It is not run again: ask the worker to run it again, or to drop it.`;
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
    "SELECT * FROM incidents WHERE state IN ('open', 'blocked', 'recovering') AND parent IS NOT NULL AND phase IN ('turn', 'compaction')",
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

function holdMatches(db: DatabaseSync, now: number): Match[] {
  return loadCards(db).flatMap(({ card, standing }) => {
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
    const open = db
      .prepare("SELECT 1 FROM findings WHERE card = ? AND condition = ? AND cleared_at IS NULL")
      .get(match.card, key);
    const to = recipientOf(db, match);
    if (open !== undefined || to === undefined) continue;
    if (match.worker !== true && !isUp(db, to)) continue;
    const fields = { condition: match.condition, tier: match.tier, finding: key };
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

export function runCheck(db: DatabaseSync, now: number, t: Timings): string[] {
  const stopped = new Set(
    loadCards(db)
      .filter(
        ({ standing }) =>
          standing.status === "done" ||
          standing.status === "dropped" ||
          standing.status === "waiting" ||
          standing.status === "paused",
      )
      .map(({ card }) => card.id),
  );
  const matches = [
    ...withIncidents(db, workerMatches(db, now, t), now, t),
    ...reminderMatches(db, now, t),
    ...decisionMatches(db, now, t),
    ...lostJobMatches(db, now, t),
    ...incidentMatches(db, now, t),
    ...holdMatches(db, now),
  ].filter((match) => !stopped.has(match.card));
  clearStopped(db, now, matches);
  const notify = new Set<string>([
    ...lostJobs(db, now, t),
    ...chaseIntake(db, now, t),
    ...scheduledWakes(db, t.wall()),
    ...dueBatches(db, { now: t.wall(), window: t.batch }),
    ...reconcileIncidents(db, now, t),
    ...lostMates(db, now, t),
    ...expireMaintenance(db, now, t),
    ...replyNudges(db, now, t),
  ]);
  writeFindings(db, now, matches, notify);
  return [...notify];
}
