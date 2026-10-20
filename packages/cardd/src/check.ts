// The timed check (spec section 13). One level-triggered pass over cards.db.
// Each rule finds (card, condition) pairs. A finding is written once while its
// condition stays true, and clears when the condition stops. The check wakes
// nobody when everything is in order.
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { loseSilentJobs } from "./attempts.ts";
import { applyChange } from "./change.ts";
import { readPullRequest, type PullRequest } from "./github.ts";
import { withdrawMerge } from "./holds.ts";
import { factsFrom, type Change } from "./status.ts";
import { addEntry, cardEntries, getCard, parentOf, phaseOf, workerOf } from "./store.ts";
import { MINUTE, type Timings } from "./timing.ts";

interface Match {
  readonly card: number;
  readonly lane: string;
  readonly condition: string;
  readonly text: string;
  /** The status change, if the finding moves the card. Reminders do not. */
  readonly change?: Change;
  /** Whether the finding ends the merge question: it asks about a PR that is closed. */
  readonly withdrawsMerge?: boolean;
  /** Whether a new finding may be written now. A finding that is already open stays open either way. */
  readonly ready?: boolean;
}

/** A card whose work is in Working or In review, with its live attempt and session. */
const WORKER_CARDS = `SELECT c.id AS card, c.lane AS lane, a.state AS attempt, a.created_at AS started,
    s.state AS state, s.last_seen AS seen, coalesce(c.last_activity, s.last_seen, 0) AS active, s.id AS session
  FROM cards c JOIN attempts a ON a.card = c.id AND a.state IN ('starting', 'active')
  JOIN sessions s ON s.attempt = a.id
  WHERE c.phase IN ('working', 'in-review')`;

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
    ).map((row) => ({
      card: Number(row["card"]),
      lane: String(row["lane"]),
      condition,
      text,
      change: FINDING,
    })),
  );
}

/** How many reminder times have passed. Past the list, one more for each repeat of the last gap. */
function reminderTier(waited: number, at: readonly number[]): number {
  const passed = at.filter((time) => waited >= time).length;
  const last = at.at(-1) ?? 0;
  const gap = last - (at.at(-2) ?? 0);
  return passed < at.length || gap <= 0 ? passed : passed + Math.floor((waited - last) / gap);
}

/** The lane that acts on a card that waits on its mate: its owner, or main when the hold waits on main. */
function actingLane(db: DatabaseSync, card: number, lane: string): string {
  const { hold } = factsFrom(cardEntries(db, card));
  return hold?.holder === "main" ? (parentOf(db, lane) ?? lane) : lane;
}

/** Cards that wait on a mate (spec section 13.1): a reminder for each tier, written while that mate is idle. A hold that waits on main reminds main. */
function reminderMatches(db: DatabaseSync, now: number, t: Timings): Match[] {
  const waiting = rows(
    db,
    "SELECT id, lane, status, updated_at FROM cards WHERE status IN ('with-mate', 'merging')",
  );
  return waiting.flatMap((row) => {
    const card = Number(row["id"]);
    const lane = actingLane(db, card, String(row["lane"]));
    const acted = db
      .prepare("SELECT max(created_at) AS at FROM entries WHERE card = ? AND author = ?")
      .get(card, `mate:${lane}`)?.["at"];
    const since = Math.max(Number(row["updated_at"]), typeof acted === "number" ? acted : 0);
    const tier = reminderTier(now - since, t.reminders);
    if (tier === 0) return [];
    const mate = db.prepare("SELECT state FROM sessions WHERE id = ? AND role = 'mate'").get(lane);
    const minutes = Math.round((now - since) / MINUTE);
    const text = `reminder: this card has waited for you (${String(row["status"])}, ${String(minutes)} min)`;
    return [
      {
        card,
        lane,
        condition: `reminder-${String(tier)}`,
        text,
        ready: mate?.["state"] === "idle",
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
    const phase = phaseOf(db, card.id);
    if (phase === "working" || phase === "in-review") applyChange(db, card, FINDING);
    return worker === undefined ? [card.lane] : [card.lane, worker];
  });
}

/** A hold whose date passed: it waits on its holder again, and that holder hears of it (spec section 17). */
function holdMatches(db: DatabaseSync, now: number): Match[] {
  const held = rows(db, "SELECT id, lane FROM cards WHERE status = 'waiting'");
  return held.flatMap((row) => {
    const card = Number(row["id"]);
    const { hold } = factsFrom(cardEntries(db, card));
    const until = hold?.until ?? null;
    if (hold === undefined || until === null || until > now) return [];
    const change: Change = { kind: "held" };
    return [
      {
        card,
        lane: actingLane(db, card, String(row["lane"])),
        condition: `hold-ended:${String(until)}`,
        text: `hold ended; it waits on ${hold.holder === "owner" ? "its mate" : hold.holder} again`,
        change,
      },
    ];
  });
}

/** The PRs of open cards, read with gh before the check's transaction. A PR that could not be read is undefined. */
export async function readPullRequests(
  db: DatabaseSync,
): Promise<Map<number, PullRequest | undefined>> {
  const cards = rows(
    db,
    "SELECT id, pr FROM cards WHERE pr IS NOT NULL AND status NOT IN ('done', 'dropped')",
  );
  const read = await Promise.all(
    cards.map(async (row) => {
      const pr = await readPullRequest(String(row["pr"])).catch((error: unknown) => {
        console.error(`timed check: ${String(error)}`);
        return undefined;
      });
      return [Number(row["id"]), pr] as const;
    }),
  );
  return new Map(read);
}

const PR_CONDITIONS: ReadonlySet<string> = new Set(["pr-merged", "pr-closed", "checks-failed"]);

/** PR state (spec section 13.1): merged, closed without a merge, or red checks while Merging. */
function prMatches(db: DatabaseSync, prs: ReadonlyMap<number, PullRequest | undefined>): Match[] {
  return [...prs].flatMap(([card, pr]): Match[] => {
    if (pr === undefined) return [];
    const row = db.prepare("SELECT lane, phase FROM cards WHERE id = ?").get(card);
    const lane = String(row?.["lane"]);
    const status = String(row?.["phase"]);
    if (pr.state === "MERGED") {
      const change: Change | undefined = status === "merging" ? undefined : { kind: "merged" };
      return [
        {
          card,
          lane,
          condition: "pr-merged",
          text: "PR merged; run cleanup",
          ...(change === undefined ? {} : { change }),
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
          change: FINDING,
          withdrawsMerge: true,
        },
      ];
    if (status !== "merging" || pr.failed.length === 0) return [];
    return [
      {
        card,
        lane,
        condition: "checks-failed",
        text: `checks failed: ${pr.failed.join(", ")}`,
        change: FINDING,
      },
    ];
  });
}

/** Clears the open findings whose condition stopped. A PR that could not be read keeps its PR findings open. */
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

/** Writes each new finding once, clears the ones whose condition stopped, and returns the sessions to push to. */
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
  const notify = new Set<string>(lostJobs(db, now, t));
  for (const match of matches) {
    const open = db
      .prepare("SELECT 1 FROM findings WHERE card = ? AND condition = ? AND cleared_at IS NULL")
      .get(match.card, match.condition);
    if (open !== undefined || match.ready === false) continue;
    if (match.withdrawsMerge === true) {
      for (const lane of withdrawMerge(db, getCard(db, match.card))) notify.add(lane);
    }
    if (match.change !== undefined) applyChange(db, getCard(db, match.card), match.change);
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
