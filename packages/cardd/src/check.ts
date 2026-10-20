// The timed check (spec section 13). One level-triggered pass over cards.db.
// Each rule finds (card, condition) pairs. A finding is written once while its
// condition stays true, and clears when the condition stops. The check wakes
// nobody when everything is in order.
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { MINUTE, type Timings } from "./timing.ts";
import { applyChange } from "./ops.ts";
import { loseSilentJobs } from "./attempts.ts";
import type { Change } from "./status.ts";
import { addEntry, getCard, workerOf } from "./store.ts";

interface Match {
  readonly card: number;
  readonly lane: string;
  readonly condition: string;
  readonly text: string;
}

/** A worker card in Working or In review, with its live attempt and session. */
const WORKER_CARDS = `SELECT c.id AS card, c.lane AS lane, a.state AS attempt, a.created_at AS started,
    s.state AS state, s.last_seen AS seen, coalesce(c.last_activity, s.last_seen, 0) AS active, s.id AS session
  FROM cards c JOIN attempts a ON a.card = c.id AND a.state IN ('starting', 'active')
  JOIN sessions s ON s.attempt = a.id
  WHERE c.status IN ('working', 'in-review')`;

const LATEST_REPORT = `(SELECT fields FROM entries WHERE card = w.card AND kind = 'report' ORDER BY id DESC LIMIT 1)`;

/** Rules that hand a worker card back to its mate (spec section 13.1). */
const WORKER_RULES: readonly {
  condition: string;
  text: string;
  where: string;
  limit: keyof Timings;
}[] = [
  {
    condition: "worker-never-connected",
    text: "worker never connected",
    where: "w.attempt = 'starting' AND ?1 - w.started > ?2",
    limit: "neverConnected",
  },
  {
    condition: "worker-not-connected",
    text: "worker not connected",
    where: "w.attempt = 'active' AND w.state IN ('exited', 'lost') AND ?1 - w.seen > ?2",
    limit: "notConnected",
  },
  {
    condition: "worker-stalled",
    text: "worker stalled",
    where: "w.state = 'running' AND ?1 - w.active > ?2",
    limit: "stall",
  },
  {
    condition: "worker-idle",
    text: "worker idle without a handoff",
    where: `w.state = 'idle' AND ?1 - w.seen > ?2
      AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.session = w.session AND d.state IN ('pending', 'pushed'))
      AND NOT (json_extract(${LATEST_REPORT}, '$.status') = 'paused'
        AND coalesce(json_extract(${LATEST_REPORT}, '$.until'), 0) > ?1)`,
    limit: "idle",
  },
];

function rows(
  db: DatabaseSync,
  sql: string,
  ...params: SQLInputValue[]
): Record<string, unknown>[] {
  return db.prepare(sql).all(...params);
}

function workerMatches(db: DatabaseSync, now: number, t: Timings): Match[] {
  return WORKER_RULES.flatMap(({ condition, text, where, limit }) =>
    rows(
      db,
      `SELECT w.card AS card, w.lane AS lane FROM (${WORKER_CARDS}) w WHERE ${where}`,
      now,
      Number(t[limit]),
    ).map((row) => ({ card: Number(row["card"]), lane: String(row["lane"]), condition, text })),
  );
}

/** How many reminder times have passed. Past the list, one more for each repeat of the last gap. */
function reminderTier(waited: number, at: readonly number[]): number {
  const passed = at.filter((time) => waited >= time).length;
  const last = at.at(-1) ?? 0;
  const gap = last - (at.at(-2) ?? 0);
  return passed < at.length || gap <= 0 ? passed : passed + Math.floor((waited - last) / gap);
}

/** Cards that wait on an idle mate (spec section 13.1): a reminder for each tier. */
function reminderMatches(db: DatabaseSync, now: number, t: Timings): Match[] {
  const waiting = rows(
    db,
    `SELECT c.id AS card, c.lane AS lane, c.status AS status, max(c.updated_at,
       coalesce((SELECT max(created_at) FROM entries WHERE card = c.id AND author = 'mate:' || c.lane), 0)) AS since
     FROM cards c JOIN sessions m ON m.id = c.lane AND m.role = 'mate' AND m.state = 'idle'
     WHERE c.status IN ('with-mate', 'merging')`,
  );
  return waiting.flatMap((row) => {
    const tier = reminderTier(now - Number(row["since"]), t.reminders);
    if (tier === 0) return [];
    const minutes = Math.round((now - Number(row["since"])) / MINUTE);
    const text = `reminder: this card has waited for you (${String(row["status"])}, ${String(minutes)} min)`;
    return [
      {
        card: Number(row["card"]),
        lane: String(row["lane"]),
        condition: `reminder-${String(tier)}`,
        text,
      },
    ];
  });
}

const FINDING: Change = { kind: "finding" };
const MISSED_HEARTBEATS = 3;

/** run_long jobs whose wrapper stopped sending heartbeats (spec section 13.1). They are not run again. */
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
    if (worker !== undefined) {
      const fields = { job: job.id, label: job.label, lost: true };
      const note = "no heartbeat arrived. It is not run again.";
      addEntry(
        db,
        { card: card.id, author: `job:${String(job.id)}`, kind: "job-result", body: note, fields },
        [worker],
      );
    }
    if (card.status === "working" || card.status === "in-review") applyChange(db, card, FINDING);
    return worker === undefined ? [card.lane] : [card.lane, worker];
  });
}

/** Writes each new finding once, clears the ones whose condition stopped, and returns the sessions to push to. */
export function runCheck(db: DatabaseSync, now: number, t: Timings): string[] {
  const matches = [...workerMatches(db, now, t), ...reminderMatches(db, now, t)];
  const live = new Set(matches.map((match) => `${String(match.card)}/${match.condition}`));
  for (const open of rows(
    db,
    "SELECT id, card, condition FROM findings WHERE cleared_at IS NULL",
  )) {
    if (!live.has(`${String(open["card"])}/${String(open["condition"])}`)) {
      db.prepare("UPDATE findings SET cleared_at = ? WHERE id = ?").run(now, Number(open["id"]));
    }
  }
  const notify = new Set<string>(lostJobs(db, now, t));
  for (const match of matches) {
    const open = db
      .prepare("SELECT 1 FROM findings WHERE card = ? AND condition = ? AND cleared_at IS NULL")
      .get(match.card, match.condition);
    if (open !== undefined) continue;
    if (!match.condition.startsWith("reminder-"))
      applyChange(db, getCard(db, match.card), { kind: "finding" });
    const fields = { condition: match.condition };
    addEntry(db, { card: match.card, author: "check", kind: "finding", body: match.text, fields }, [
      match.lane,
    ]);
    db.prepare("INSERT INTO findings (card, condition, opened_at) VALUES (?, ?, ?)").run(
      match.card,
      match.condition,
      now,
    );
    notify.add(match.lane);
  }
  return [...notify];
}
