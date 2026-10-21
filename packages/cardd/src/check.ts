import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { loseSilentJobs } from "./attempts.ts";
import { chaseIntake } from "./deliveries.ts";
import type { PullRequest } from "./github.ts";
import { withdrawMerge } from "./holds.ts";
import { lookUpPr } from "./pulls.ts";
import { replyNudges } from "./replies.ts";
import { factsFrom, finishFrom, type Stage } from "./status.ts";
import {
  addEntry,
  cardEntries,
  getCard,
  loadCards,
  parentOf,
  transaction,
  workerOf,
} from "./store.ts";
import { MINUTE, type Timings } from "./timing.ts";

interface Match {
  readonly card: number;
  readonly lane: string;
  readonly condition: string;
  readonly text: string;
  readonly to?: string;
  readonly withdrawsMerge?: "closed" | "merged";
  readonly ready?: boolean;
  readonly quiet?: boolean;
}

const WORKING: ReadonlySet<Stage> = new Set(["working", "in-review"]);

const workerCards = (
  ids: readonly number[],
): string => `SELECT c.id AS card, c.lane AS lane, a.state AS attempt, a.created_at AS started,
    s.state AS state, s.last_seen AS seen, coalesce(c.last_activity, s.last_seen, 0) AS active, s.id AS session
  FROM cards c JOIN attempts a ON a.card = c.id AND a.state IN ('starting', 'active')
  JOIN sessions s ON s.attempt = a.id
  WHERE c.id IN (${ids.map(Number).join(", ")})`;

const LATEST_REPORT = `(SELECT fields FROM entries WHERE card = w.card AND kind = 'report' ORDER BY id DESC LIMIT 1)`;

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
  const ids = loadCards(db)
    .filter(({ standing }) => WORKING.has(standing.stage))
    .map(({ card }) => card.id);
  if (ids.length === 0) return [];
  return WORKER_RULES.flatMap(({ condition, text, where, limit }) =>
    rows(
      db,
      `SELECT w.card AS card, w.lane AS lane FROM (${workerCards(ids)}) w WHERE ${where}`,
      now,
      Number(t[limit]),
    ).map((row) => ({
      card: Number(row["card"]),
      lane: String(row["lane"]),
      condition,
      text,
    })),
  );
}

function reminderTier(waited: number, at: readonly number[]): number {
  const passed = at.filter((time) => waited >= time).length;
  const last = at.at(-1) ?? 0;
  const gap = last - (at.at(-2) ?? 0);
  return passed < at.length || gap <= 0 ? passed : passed + Math.floor((waited - last) / gap);
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
    return "Once the merge is authorized (yolo on with green checks, or the captain's word for this PR), comment the worker to merge its PR, then close(card, summary). If it will not land, close(card, summary=<why>, landed=false).";
  return "No PR was found for its branch: comment the worker to open one from its task branch. If it made no code change, close it with close(card, summary). Otherwise close(card, summary=<why>, landed=false).";
}

const minutesSince = (now: number, since: number): number => Math.round((now - since) / MINUTE);
const stateOf = (db: DatabaseSync, lane: string | null): unknown =>
  lane === null
    ? undefined
    : db.prepare("SELECT state FROM sessions WHERE id = ? AND role = 'mate'").get(lane)?.["state"];

function finishedMatches(
  db: DatabaseSync,
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
  const name = `c-${String(card.id)}`;
  const close = closeAdvice(card.kind, finish.merged, card.pr !== null, card.delivery);
  const waited = `${card.status}, ${String(minutesSince(now, since))} min`;
  const tier = reminderTier(now - since, t.finished);
  const reminders: Match[] =
    tier === 0
      ? []
      : [
          {
            card: card.id,
            lane: card.lane,
            condition: `finished-${String(tier)}`,
            text: `reminder: ${name} is finished and still open (${waited}). ${close}`,
            ready: stateOf(db, card.lane) === "idle",
          },
        ];
  const parent = parentOf(db, card.lane);
  const escalation = reminderTier(now - since, t.escalations);
  if (parent === null || escalation === 0) return reminders;
  const text = `escalation: ${name} finished ${String(minutesSince(now, since))} min ago and ${card.lane} has not closed it (${card.status}). ${close} Or ask ${card.lane} why.`;
  return [
    ...reminders,
    {
      card: card.id,
      lane: card.lane,
      to: parent,
      condition: `escalated-${String(escalation)}`,
      text,
      ready: stateOf(db, parent) === "idle",
    },
  ];
}

function reminderMatches(db: DatabaseSync, now: number, t: Timings): Match[] {
  return loadCards(db).flatMap(({ card: own, entries, standing }) => {
    if (own.status !== "with-mate" && own.status !== "merging") return [];
    const card = own.id;
    const { hold } = standing.facts;
    const finish = finishFrom(entries);
    if (hold === undefined && (finish.merged || finish.workerDone)) {
      return finishedMatches(db, { ...own, since: standing.since }, finish, now, t);
    }
    const lane = actingLane(db, card, own.lane);
    const acted = db
      .prepare("SELECT max(created_at) AS at FROM entries WHERE card = ? AND author = ?")
      .get(card, `mate:${lane}`)?.["at"];
    const since = Math.max(standing.since, typeof acted === "number" ? acted : 0);
    const tier = reminderTier(now - since, t.reminders);
    if (tier === 0) return [];
    const text = `reminder: this card has waited for you (${own.status}, ${String(minutesSince(now, since))} min)`;
    const ready = stateOf(db, lane) === "idle";
    return [{ card, lane, condition: `reminder-${String(tier)}`, text, ready }];
  });
}

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
    if (worker !== undefined) {
      const fields = { job: job.id, label: job.label, lost: true };
      const note = "no heartbeat arrived. It is not run again.";
      addEntry(
        db,
        { card: card.id, author: `job:${String(job.id)}`, kind: "job-result", body: note, fields },
        [worker],
      );
    }
    return worker === undefined ? [card.lane] : [card.lane, worker];
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
      },
    ];
  });
}

const PR_LOOKUPS_AT_ONCE = 4;

async function inBatches<T, R>(
  items: readonly T[],
  size: number,
  each: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let at = 0; at < items.length; at += size)
    results.push(...(await Promise.all(items.slice(at, at + size).map(each))));
  return results;
}

export async function readPullRequests(
  db: DatabaseSync,
): Promise<Map<number, PullRequest | undefined>> {
  const cards = rows(
    db,
    `SELECT c.id AS id FROM cards c JOIN projects p ON p.name = c.project
       WHERE c.kind = 'ship' AND c.delivery IS NOT 'local-only'
         AND (p.repo IS NOT NULL OR c.pr IS NOT NULL)
         AND EXISTS (SELECT 1 FROM attempts a WHERE a.card = c.id)`,
  );
  const open = cards.filter((row) => {
    const { status } = getCard(db, Number(row["id"]));
    return status !== "done" && status !== "dropped";
  });
  const read = await inBatches(open, PR_LOOKUPS_AT_ONCE, async (row) => {
    const card = Number(row["id"]);
    const found = await lookUpPr(db, card);
    if (found.kind === "unknown") console.error(`timed check: c-${String(card)}: ${found.reason}`);
    return [card, found] as const;
  });
  return new Map(
    read.flatMap(([card, found]): [number, PullRequest | undefined][] =>
      found.kind === "none" ? [] : [[card, found.kind === "found" ? found.pr : undefined]],
    ),
  );
}

const PR_CONDITIONS: ReadonlySet<string> = new Set(["pr-merged", "pr-closed", "checks-failed"]);

function prMatches(db: DatabaseSync, prs: ReadonlyMap<number, PullRequest | undefined>): Match[] {
  return [...prs].flatMap(([card, pr]): Match[] => {
    if (pr === undefined) return [];
    const { lane, status } = getCard(db, card);
    if (pr.state === "MERGED") {
      return [
        {
          card,
          lane,
          condition: "pr-merged",
          text: "PR merged; close it with close(card, summary)",
          withdrawsMerge: "merged" as const,
        },
      ];
    }
    if (pr.state === "CLOSED")
      return [
        {
          card,
          lane,
          condition: "pr-closed",
          text: "PR closed without a merge",
          withdrawsMerge: "closed" as const,
        },
      ];
    if (status !== "merging" || pr.failed.length === 0) return [];
    return [
      {
        card,
        lane,
        condition: "checks-failed",
        text: `checks failed: ${pr.failed.join(", ")}`,
      },
    ];
  });
}

function clearStopped(
  db: DatabaseSync,
  now: number,
  matches: readonly Match[],
  prs: ReadonlyMap<number, PullRequest | undefined>,
): void {
  const live = new Set(matches.map((match) => `${String(match.card)}/${match.condition}`));
  const unread = new Set([...prs].flatMap(([card, pr]) => (pr === undefined ? [card] : [])));
  for (const open of rows(
    db,
    "SELECT id, card, condition FROM findings WHERE cleared_at IS NULL",
  )) {
    const card = Number(open["card"]);
    const condition = String(open["condition"]);
    const stays =
      live.has(`${String(card)}/${condition}`) ||
      (unread.has(card) && PR_CONDITIONS.has(condition));
    if (!stays) {
      db.prepare("UPDATE findings SET cleared_at = ? WHERE id = ?").run(now, Number(open["id"]));
    }
  }
}

function writeFindings(
  db: DatabaseSync,
  now: number,
  matches: readonly Match[],
  notify: Set<string>,
): void {
  for (const match of matches) {
    const open = db
      .prepare("SELECT 1 FROM findings WHERE card = ? AND condition = ? AND cleared_at IS NULL")
      .get(match.card, match.condition);
    if (open !== undefined || match.ready === false) continue;
    if (match.withdrawsMerge !== undefined) {
      for (const lane of withdrawMerge(db, getCard(db, match.card), match.withdrawsMerge))
        notify.add(lane);
    }
    const fields = { condition: match.condition };
    const to = match.quiet === true ? [] : [match.to ?? match.lane];
    addEntry(
      db,
      { card: match.card, author: "check", kind: "finding", body: match.text, fields },
      to,
    );
    db.prepare("INSERT INTO findings (card, condition, opened_at) VALUES (?, ?, ?)").run(
      match.card,
      match.condition,
      now,
    );
    for (const each of to) notify.add(each);
  }
}

export function runCheck(
  db: DatabaseSync,
  now: number,
  t: Timings,
  prs: ReadonlyMap<number, PullRequest | undefined> = new Map(),
): string[] {
  const matches = [
    ...workerMatches(db, now, t),
    ...reminderMatches(db, now, t),
    ...holdMatches(db, now),
    ...prMatches(db, prs),
  ];
  clearStopped(db, now, matches, prs);
  const notify = new Set<string>([
    ...lostJobs(db, now, t),
    ...chaseIntake(db, now, t),
    ...replyNudges(db, now, t),
  ]);
  writeFindings(db, now, matches, notify);
  return [...notify];
}

export async function recordMerge(db: DatabaseSync, card: number): Promise<string[]> {
  const { kind, delivery } = getCard(db, card);
  if (kind !== "ship" || delivery === "local-only" || finishFrom(cardEntries(db, card)).merged)
    return [];
  const found = await lookUpPr(db, card);
  if (found.kind !== "found" || found.pr.state !== "MERGED") return [];
  const pr = found.pr;
  return transaction(db, () => {
    const notify = new Set<string>();
    const matches = prMatches(db, new Map([[card, pr]])).map((match) => ({
      ...match,
      quiet: true,
    }));
    writeFindings(db, Date.now(), matches, notify);
    return [...notify];
  });
}
