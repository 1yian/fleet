import type { DatabaseSync } from "node:sqlite";
import {
  jobIsRunning,
  parseJobState,
  type DatedWait,
  type OpArgs,
  type Wait,
} from "@fleet/protocol";
import { requireCaptainWords } from "./authority.ts";
import type { Standing } from "./status.ts";
import { reachable, workerOf, type Loaded, type Session } from "./store.ts";

type Watching = Pick<DatedWait, "watch" | "what">;

const WAIT_HELP =
  "a dated hold must say what it waits on, with exactly one of: job=<id of a running job that checks the event>, schedule=<id of a schedule that wakes you>, worker=<card number of a live worker that checks it>, watcher=<who else checks it and how, which fleet cannot check>, outside=<the outside date or event that needs no checking, such as a quota reset>, or said=<the captain's exact words when he said later>. A date with none of these is an idle park: nothing runs for it, and the fleet lists it for action";

const REMAINING_HELP =
  "a dated hold must state the work that remains besides the event: remaining=[] when nothing else is left, or remaining=[<card numbers>] for the steps that do not depend on the event, each one an open card of its own (or the captain-only card that holds its decision). The date covers only what waits on the event: split the rest into its own cards first";

const alive = (what: string): Watching => ({ watch: "running", what });
const gone = (what: string): Watching => ({ watch: "gone", what });

function jobWatch(db: DatabaseSync, id: number): Watching {
  const row = db.prepare("SELECT label, state FROM jobs WHERE id = ?").get(id);
  if (row === undefined) return gone(`job ${String(id)} does not exist`);
  const name = `job ${String(id)} (${String(row["label"])})`;
  const state = parseJobState(row["state"]);
  return jobIsRunning(state) ? alive(name) : gone(`${name} is ${state}`);
}

function scheduleWatch(db: DatabaseSync, id: number): Watching {
  const row = db.prepare("SELECT at, timezone, on_date FROM schedules WHERE id = ?").get(id);
  if (row === undefined) return gone(`schedule ${String(id)} is gone (removed, or it fired once)`);
  const when = `${typeof row["on_date"] === "string" ? `${row["on_date"]} ` : ""}${String(row["at"])} ${String(row["timezone"])}`;
  return alive(`schedule ${String(id)} (${when})`);
}

function workerWatch(db: DatabaseSync, card: number): Watching {
  const name = `the worker of c-${String(card)}`;
  return workerOf(db, card) === undefined ? gone(`${name} is not running`) : alive(name);
}

const CHECKED: Record<"job" | "schedule" | "worker", (db: DatabaseSync, id: number) => Watching> = {
  job: jobWatch,
  schedule: scheduleWatch,
  worker: workerWatch,
};

const STATED: Record<"watcher" | "outside" | "later", DatedWait["watch"]> = {
  watcher: "unchecked",
  outside: "outside",
  later: "later",
};

function watching(db: DatabaseSync, wait: Wait | null): Watching {
  if (wait === null) return { watch: "none", what: "" };
  if ("id" in wait) return CHECKED[wait.by](db, wait.id);
  return { watch: STATED[wait.by], what: wait.text };
}

export function datedWait(db: DatabaseSync, standing: Standing): DatedWait | null {
  const { hold } = standing.facts;
  if (standing.status !== "waiting" || hold === undefined || hold.until === null) return null;
  return { until: hold.until, since: hold.openedAt, ...watching(db, hold.wait) };
}

export function datedWaits(db: DatabaseSync, open: readonly Loaded[]): Map<number, DatedWait> {
  const waits = new Map<number, DatedWait>();
  for (const { card, standing } of open) {
    const wait = datedWait(db, standing);
    if (wait !== null) waits.set(card.id, wait);
  }
  return waits;
}

function statedWaits(args: OpArgs<"hold">): Wait[] {
  const waits: Wait[] = [];
  if (args.job !== undefined) waits.push({ by: "job", id: args.job });
  if (args.schedule !== undefined) waits.push({ by: "schedule", id: args.schedule });
  if (args.worker !== undefined) waits.push({ by: "worker", id: args.worker });
  if (args.watcher !== undefined) waits.push({ by: "watcher", text: args.watcher });
  if (args.outside !== undefined) waits.push({ by: "outside", text: args.outside });
  if (args.said !== undefined) waits.push({ by: "later", text: args.said });
  return waits;
}

function requireWait(db: DatabaseSync, args: OpArgs<"hold">): Wait {
  const [wait, ...extra] = statedWaits(args);
  if (wait === undefined || extra.length > 0) throw new Error(WAIT_HELP);
  const seen = watching(db, wait);
  if (seen.watch === "gone")
    throw new Error(`a dated hold needs a watcher that runs now, and ${seen.what}`);
  if (!("id" in wait) && wait.by === "later")
    requireCaptainWords(db, wait.text, args.source ?? "record");
  return wait;
}

function requireCards(
  db: DatabaseSync,
  session: Session,
  own: number,
  remaining: OpArgs<"hold">["remaining"],
): number[] {
  if (remaining === undefined) throw new Error(REMAINING_HELP);
  for (const card of remaining) {
    const name = `c-${String(card)}`;
    if (card === own) throw new Error(`${name} is the held card: a step needs a card of its own`);
    const { status } = reachable(db, session, card).card;
    if (status === "done" || status === "dropped")
      throw new Error(`${name} is ${status}: a remaining step needs an open card`);
  }
  return remaining;
}

const DATING_KEYS = [
  "job",
  "schedule",
  "worker",
  "watcher",
  "outside",
  "said",
  "remaining",
] as const;

export interface Dating {
  readonly wait: Wait | null;
  readonly remaining: readonly number[];
}

export function dating(
  db: DatabaseSync,
  session: Session,
  own: number,
  args: OpArgs<"hold">,
): Dating {
  if (args.until === undefined) {
    const stray = DATING_KEYS.filter((key) => args[key] !== undefined);
    if (stray.length > 0) throw new Error(`${stray.join(", ")} only go with until`);
    return { wait: null, remaining: [] };
  }
  return { wait: requireWait(db, args), remaining: requireCards(db, session, own, args.remaining) };
}
