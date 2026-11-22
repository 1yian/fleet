import {
  approvedBy,
  approvesOf,
  ATTENTIONS,
  HANDOFF_REPORTS,
  HOLDERS,
  parseCards,
  parseWait,
  toWorker,
  type Attention,
  type CardKind,
  type Entry,
  type Holder,
  type Status,
  type Wait,
} from "@fleet/protocol";

type Stage = "queued" | "working" | "in-review" | "with-mate" | "merging" | "done" | "dropped";

export interface Hold {
  readonly occurrence: number;
  readonly holder: Holder;
  readonly question: string;
  readonly options: readonly string[];
  readonly merge: boolean;
  readonly unlanded: boolean;
  readonly originalMerge: boolean;
  readonly approves: readonly string[];
  readonly keys: readonly string[];
  readonly fromWorker: boolean;
  readonly until: number | null;
  readonly wait: Wait | null;
  readonly remaining: readonly number[];
  readonly openedAt: number;
  readonly author: string;
  readonly entry: number;
  readonly review: string | undefined;
  readonly reviewRequests: readonly number[] | undefined;
}

export interface Basis {
  readonly kind: CardKind;
  readonly yolo: boolean;
  readonly createdAt: number;
}

const isClosed = (stage: Stage): boolean => stage === "done" || stage === "dropped";

const text = (entry: Entry, key: string): string | undefined => {
  const value = entry.fields[key];
  return typeof value === "string" ? value : undefined;
};

const holderOf = (value: unknown): Holder =>
  HOLDERS.find((holder) => holder === value) ?? "captain";

const textsOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.map(String).filter((each) => each !== "") : [];

interface Tally {
  hold: Hold | undefined;
  occurrences: number;
  mergeApproved: boolean;
  awaitingMerge: boolean;
  inPipeline: boolean;
  stage: Stage;
  attention: Attention | undefined;
  pausedUntil: number | null;
}

function reviewOf(entry: Entry, open: Hold | undefined): Pick<Hold, "review" | "reviewRequests"> {
  const review = entry.fields["review"];
  const requests = entry.fields["reviewRequests"];
  const carried = typeof review === "string" ? review : open?.review;
  return {
    review: review === false ? undefined : carried,
    reviewRequests: Array.isArray(requests) ? parseCards(requests) : open?.reviewRequests,
  };
}

function holdFrom(tally: Tally, entry: Entry): void {
  const merge = entry.fields["merge"] === true;
  const until = entry.fields["until"];
  const open = tally.hold;
  const options = textsOf(entry.fields["options"]);
  const approves = approvesOf(entry.fields);
  const originalMerge =
    merge &&
    (entry.author === "fleet" ||
      (open?.originalMerge === true &&
        JSON.stringify([options, approves]) === JSON.stringify([open.options, open.approves])));
  const written = {
    holder: holderOf(entry.fields["holder"]),
    question: entry.body,
    options,
    merge,
    unlanded: entry.fields["unlanded"] === true,
    originalMerge,
    approves,
    until: typeof until === "number" ? until : null,
    wait: parseWait(entry.fields["wait"]),
    remaining: parseCards(entry.fields["remaining"]),
    author: entry.author,
    entry: entry.id,
    ...reviewOf(entry, open),
  };
  if (open === undefined) {
    const opened = { occurrence: ++tally.occurrences, openedAt: entry.createdAt };
    tally.hold = { ...written, ...opened, keys: [], fromWorker: false };
    if (merge) tally.mergeApproved = false;
  } else tally.hold = { ...open, ...written };
}

function decide(tally: Tally, entry: Entry, key: string): void {
  const open = tally.hold;
  if (open === undefined) {
    tally.hold = {
      occurrence: ++tally.occurrences,
      holder: "owner",
      question: entry.body,
      options: [],
      merge: false,
      unlanded: false,
      originalMerge: false,
      approves: [],
      keys: [key],
      fromWorker: true,
      until: null,
      wait: null,
      remaining: [],
      openedAt: entry.createdAt,
      author: entry.author,
      entry: entry.id,
      review: undefined,
      reviewRequests: undefined,
    };
  } else if (!open.keys.includes(key)) tally.hold = { ...open, keys: [...open.keys, key] };
}

function answerKey(tally: Tally, key: string): boolean {
  const open = tally.hold;
  if (!open?.keys.includes(key)) return false;
  const keys = open.keys.filter((each) => each !== key);
  tally.hold = open.fromWorker && keys.length === 0 ? undefined : { ...open, keys };
  return true;
}

function moveTo(tally: Tally, stage: Stage): void {
  tally.stage = stage;
  tally.attention = undefined;
  tally.pausedUntil = null;
}

function resume(tally: Tally): void {
  tally.pausedUntil = null;
  if (tally.stage !== "with-mate" || (tally.hold?.keys.length ?? 0) > 0) return;
  moveTo(tally, tally.inPipeline ? "in-review" : "working");
}

function handBack(tally: Tally): void {
  moveTo(tally, tally.stage === "merging" ? "merging" : "with-mate");
}

function done(basis: Basis, tally: Tally): void {
  tally.inPipeline = false;
  tally.awaitingMerge = true;
  const lands = tally.stage === "merging" || (basis.kind === "ship" && basis.yolo);
  moveTo(tally, lands ? "merging" : "with-mate");
}

function stopWith(tally: Tally, status: string): void {
  moveTo(tally, "with-mate");
  tally.attention = ATTENTIONS.find((each) => each === status);
}

type ReportEffect = (basis: Basis, tally: Tally, entry: Entry, key: string) => void;

const REPORT_EFFECTS: Partial<Record<string, ReportEffect>> = {
  working: (_basis, tally) => {
    resume(tally);
  },
  paused: (_basis, tally, entry) => {
    if (tally.stage !== "merging") moveTo(tally, tally.inPipeline ? "in-review" : "working");
    const until = entry.fields["until"];
    tally.pausedUntil = typeof until === "number" ? until : null;
  },
  blocked: (_basis, tally) => {
    stopWith(tally, "blocked");
  },
  stopped: (_basis, tally) => {
    stopWith(tally, "stopped");
  },
  failed: (_basis, tally) => {
    tally.inPipeline = false;
    tally.awaitingMerge = false;
    stopWith(tally, "failed");
  },
  "needs-decision": (_basis, tally, entry, key) => {
    tally.awaitingMerge = false;
    moveTo(tally, "with-mate");
    decide(tally, entry, key);
  },
  resolved: (_basis, tally, _entry, key) => {
    if (tally.hold?.reviewRequests !== undefined) return;
    answerKey(tally, key);
    resume(tally);
  },
  "in-review": (_basis, tally) => {
    tally.inPipeline = true;
    tally.awaitingMerge = false;
    moveTo(tally, "in-review");
  },
  done,
  merged: done,
};

function answered(tally: Tally, entry: Entry): void {
  if (tally.hold?.merge === true) {
    tally.mergeApproved = approvedBy(entry.fields);
    tally.awaitingMerge = false;
    if (tally.mergeApproved) moveTo(tally, "merging");
    else handBack(tally);
  } else handBack(tally);
  tally.hold = undefined;
}

function released(tally: Tally, entry: Entry): void {
  tally.hold = undefined;
  if (entry.fields["withdrawn"] !== true) handBack(tally);
}

function commented(tally: Tally, entry: Entry): void {
  if (entry.author === "captain") {
    if (
      tally.hold?.holder === "captain" &&
      tally.hold.reviewRequests === undefined &&
      entry.fields["signinGrant"] !== true
    )
      tally.hold = { ...tally.hold, holder: "owner" };
    return;
  }
  tally.awaitingMerge = false;
  answerKey(tally, text(entry, "resolves") ?? "");
  if (entry.fields["task"] !== undefined) {
    tally.inPipeline = false;
    moveTo(tally, "working");
  } else if (toWorker(entry)) resume(tally);
}

const ENTRY_EFFECTS: Partial<Record<string, (basis: Basis, tally: Tally, entry: Entry) => void>> = {
  hold: (_basis, tally, entry) => {
    holdFrom(tally, entry);
  },
  release: (_basis, tally, entry) => {
    released(tally, entry);
  },
  answer: (_basis, tally, entry) => {
    answered(tally, entry);
  },
  comment: (_basis, tally, entry) => {
    commented(tally, entry);
  },
  report: (basis, tally, entry) => {
    REPORT_EFFECTS[text(entry, "status") ?? ""]?.(basis, tally, entry, text(entry, "key") ?? "");
  },
  "review-feedback": (_basis, tally, entry) => {
    if (answerKey(tally, text(entry, "resolves") ?? "")) resume(tally);
  },
  cleanup: (_basis, tally, entry) => {
    tally.hold = undefined;
    moveTo(tally, text(entry, "outcome") === "dropped" ? "dropped" : "done");
  },
};

export const affectsStanding = (kind: string): boolean => Object.hasOwn(ENTRY_EFFECTS, kind);

export interface Facts {
  readonly hold: Hold | undefined;
  readonly occurrences: number;
  readonly inPipeline: boolean;
  readonly mergeApproved: boolean;
  readonly awaitingMerge: boolean;
  readonly pausedUntil: number | null;
}

export interface Standing {
  readonly status: Status;
  readonly stage: Stage;
  readonly since: number;
  readonly attention: Attention | null;
  readonly until: number | null;
  readonly facts: Facts;
}

export const holdDeferred = (hold: Hold, now: number): boolean =>
  hold.until !== null && hold.until > now;

function holdStatus(hold: Hold, now: number): Status {
  if (holdDeferred(hold, now)) return "waiting";
  return hold.holder === "captain" ? "needs-you" : "with-mate";
}

const pauseInForce = (until: number | null, now: number): boolean => (until ?? 0) > now;

const RESTING: ReadonlySet<Stage> = new Set(["working", "in-review"]);

function untilOf(status: Status, tally: Tally): number | null {
  if (status === "paused") return tally.pausedUntil;
  return status === "waiting" ? (tally.hold?.until ?? null) : null;
}

function statusAt(basis: Basis, tally: Tally, now: number): Status {
  if (isClosed(tally.stage)) return tally.stage;
  if (tally.hold !== undefined) return holdStatus(tally.hold, now);
  if (basis.kind === "standing") return "waiting";
  return RESTING.has(tally.stage) && pauseInForce(tally.pausedUntil, now) ? "paused" : tally.stage;
}

function factsOf(tally: Tally): Facts {
  return {
    hold: tally.hold,
    occurrences: tally.occurrences,
    inPipeline: tally.inPipeline,
    mergeApproved: tally.mergeApproved,
    awaitingMerge: tally.awaitingMerge,
    pausedUntil: tally.pausedUntil,
  };
}

const NEUTRAL: Basis = { kind: "scout", yolo: false, createdAt: 0 };

function replay(basis: Basis, entries: readonly Entry[], now: number) {
  const tally: Tally = {
    hold: undefined,
    occurrences: 0,
    mergeApproved: false,
    awaitingMerge: false,
    inPipeline: false,
    stage: "queued",
    attention: undefined,
    pausedUntil: null,
  };
  let status = statusAt(basis, tally, basis.createdAt);
  let since = basis.createdAt;
  for (const entry of entries) {
    if (isClosed(tally.stage)) break;
    ENTRY_EFFECTS[entry.kind]?.(basis, tally, entry);
    const next = statusAt(basis, tally, entry.createdAt);
    if (next !== status) since = entry.createdAt;
    status = next;
  }
  const current = statusAt(basis, tally, now);
  const lapsed = Math.max(tally.hold?.until ?? 0, tally.pausedUntil ?? 0);
  return { tally, status: current, since: current === status ? since : Math.max(since, lapsed) };
}

export function factsFrom(entries: readonly Entry[]): Facts {
  return factsOf(replay(NEUTRAL, entries, 0).tally);
}

export function standingFrom(basis: Basis, entries: readonly Entry[], now: number): Standing {
  const { tally, status, since } = replay(basis, entries, now);
  const needsAttention =
    status === "with-mate" && tally.stage === "with-mate" && tally.hold === undefined;
  return {
    status,
    stage: tally.stage,
    since,
    attention: needsAttention ? (tally.attention ?? null) : null,
    until: untilOf(status, tally),
    facts: factsOf(tally),
  };
}

export function pausedNow(standing: Standing, now: number): boolean {
  return pauseInForce(standing.facts.pausedUntil, now);
}

export function acceptsRestartNotice(
  { standing, entries }: { standing: Standing; entries: readonly Entry[] },
  now: number,
): boolean {
  return standing.status === "working" && !pausedNow(standing, now) && !isFinished(entries);
}

export function resting(standing: Standing): boolean {
  return RESTING.has(standing.stage);
}

export function idleNow(standing: Standing, now: number): boolean {
  return resting(standing) && !pausedNow(standing, now);
}

export function isFinished(entries: readonly Entry[]): boolean {
  return finishFrom(entries).workerDone;
}

export function finishedOpen(entries: readonly Entry[]): Finish | undefined {
  const finish = finishFrom(entries);
  return finish.workerDone || finish.merged ? finish : undefined;
}

export interface Finish {
  readonly merged: boolean;
  readonly workerDone: boolean;
  readonly emptyBranch: boolean;
  readonly at: number;
}

const isMerge = (entry: Entry): boolean =>
  entry.kind === "report" && entry.author.startsWith("worker:") && entry.fields["merged"] === true;

export function finishFrom(entries: readonly Entry[]): Finish {
  const finish = { merged: false, workerDone: false, emptyBranch: false, at: 0 };
  for (const entry of entries) {
    const status = text(entry, "status");
    if (isMerge(entry)) {
      finish.merged = true;
      finish.workerDone = true;
      finish.at = entry.createdAt;
    } else if (entry.kind === "comment" && toWorker(entry)) {
      finish.workerDone = false;
      finish.emptyBranch = false;
    } else if (entry.kind === "report" && status !== undefined && HANDOFF_REPORTS.has(status)) {
      finish.workerDone = status === "done";
      finish.emptyBranch = finish.workerDone && entry.fields["emptyBranch"] === true;
      if (finish.workerDone) finish.at = entry.createdAt;
    }
  }
  return finish;
}

export function doneStands(entries: readonly Entry[]): boolean {
  let stands = false;
  for (const entry of entries) {
    const status = text(entry, "status");
    if (entry.kind === "comment" && toWorker(entry)) stands = false;
    else if (entry.kind === "report" && status !== "note")
      stands = status === "done" || status === "merged";
  }
  return stands;
}
