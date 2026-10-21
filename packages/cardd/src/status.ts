import {
  HOLDERS,
  MERGE_OPTIONS,
  type CardKind,
  type Entry,
  type Holder,
  type ReportStatus,
  type Status,
} from "@fleet/protocol";

export const PHASES = [
  "queued",
  "working",
  "in-review",
  "with-mate",
  "merging",
  "done",
  "dropped",
] as const;
export type Phase = (typeof PHASES)[number];

export interface Hold {
  readonly occurrence: number;
  readonly holder: Holder;
  readonly question: string;
  readonly options: readonly string[];
  readonly merge: boolean;
  readonly keys: readonly string[];
  readonly fromWorker: boolean;
  readonly until: number | null;
  readonly entry: number;
}

export interface CardFacts {
  readonly phase: Phase;
  readonly kind: CardKind;
  readonly hold: Hold | undefined;
  readonly inPipeline: boolean;
  readonly yolo: boolean;
}

const FIXED = {
  dispatch: "working",
  finding: "with-mate",
  merged: "merging",
  cleanup: "done",
  drop: "dropped",
} as const satisfies Record<string, Phase>;
interface FixedChange {
  readonly kind: keyof typeof FIXED;
}

export type Change =
  | FixedChange
  | { readonly kind: "held" }
  | { readonly kind: "released"; readonly outcome?: "approve" | "changes" | "withdrawn" }
  | { readonly kind: "report"; readonly status: ReportStatus }
  | { readonly kind: "comment" }
  | { readonly kind: "answered" };

const isFixed = (change: Change): change is FixedChange => Object.hasOwn(FIXED, change.kind);

const CLOSED: ReadonlySet<Phase> = new Set(["done", "dropped"]);
const HANDOFFS: ReadonlySet<ReportStatus> = new Set([
  "blocked",
  "needs-decision",
  "failed",
  "stopped",
]);

export function nextPhase(card: CardFacts, change: Change): Phase | Error {
  return CLOSED.has(card.phase) ? new Error(`card is ${card.phase}`) : byKind(card, change);
}

function byKind(card: CardFacts, change: Change): Phase {
  if (isFixed(change)) return FIXED[change.kind];
  switch (change.kind) {
    case "held":
      return card.phase;
    case "released":
      return afterRelease(card, change.outcome);
    case "report":
      return afterReport(card, change.status);
    case "comment":
    case "answered":
      return afterComment(card);
  }
}

function afterRelease(
  card: CardFacts,
  outcome: "approve" | "changes" | "withdrawn" | undefined,
): Phase {
  if (outcome === "withdrawn") return card.phase;
  if (outcome === "changes") return "working";
  return outcome === "approve" || card.phase === "merging" ? "merging" : "with-mate";
}

function afterReport(card: CardFacts, status: ReportStatus): Phase {
  if (status === "in-review") return "in-review";
  if (status === "done")
    return card.phase === "merging" || (card.kind === "ship" && card.yolo)
      ? "merging"
      : "with-mate";
  return HANDOFFS.has(status) ? "with-mate" : card.phase;
}

function afterComment(card: CardFacts): Phase {
  if (card.phase !== "with-mate" || (card.hold?.keys.length ?? 0) > 0) return card.phase;
  return card.inPipeline ? "in-review" : "working";
}

export function statusOf(phase: Phase, hold: Hold | undefined, now: number): Status {
  if (CLOSED.has(phase) || hold === undefined) return phase;
  if (hold.until !== null && hold.until > now) return "waiting";
  return hold.holder === "captain" ? "needs-you" : "with-mate";
}

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
}

function holdFrom(tally: Tally, entry: Entry): void {
  const merge = entry.fields["merge"] === true;
  const until = entry.fields["until"];
  const written = {
    holder: holderOf(entry.fields["holder"]),
    question: entry.body,
    options: textsOf(entry.fields["options"]),
    merge,
    until: typeof until === "number" ? until : null,
    entry: entry.id,
  };
  const open = tally.hold;
  if (open === undefined) {
    tally.hold = { ...written, occurrence: ++tally.occurrences, keys: [], fromWorker: false };
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
      keys: [key],
      fromWorker: true,
      until: null,
      entry: entry.id,
    };
  } else if (!open.keys.includes(key)) tally.hold = { ...open, keys: [...open.keys, key] };
}

function answerKey(tally: Tally, key: string): void {
  const open = tally.hold;
  if (open === undefined) return;
  const keys = open.keys.filter((each) => each !== key);
  tally.hold = open.fromWorker && keys.length === 0 ? undefined : { ...open, keys };
}

const REPORT_EFFECTS: Partial<Record<string, (tally: Tally, entry: Entry, key: string) => void>> = {
  "needs-decision": (tally, entry, key) => {
    tally.awaitingMerge = false;
    decide(tally, entry, key);
  },
  resolved: (tally, _entry, key) => {
    answerKey(tally, key);
  },
  "in-review": (tally) => {
    tally.inPipeline = true;
    tally.awaitingMerge = false;
  },
  done: (tally) => {
    tally.inPipeline = false;
    tally.awaitingMerge = true;
  },
  failed: (tally) => {
    tally.inPipeline = false;
    tally.awaitingMerge = false;
  },
};

const ENTRY_EFFECTS: Partial<Record<string, (tally: Tally, entry: Entry) => void>> = {
  hold: holdFrom,
  release: (tally) => {
    tally.hold = undefined;
  },
  answer: (tally, entry) => {
    if (tally.hold?.merge === true) {
      tally.mergeApproved = text(entry, "choice") === MERGE_OPTIONS[0];
      tally.awaitingMerge = false;
    }
    tally.hold = undefined;
  },
  comment: (tally, entry) => {
    if (entry.author === "captain") {
      if (tally.hold?.holder === "captain") tally.hold = { ...tally.hold, holder: "owner" };
    } else {
      tally.awaitingMerge = false;
      answerKey(tally, text(entry, "resolves") ?? "");
    }
  },
  report: (tally, entry) =>
    REPORT_EFFECTS[text(entry, "status") ?? ""]?.(tally, entry, text(entry, "key") ?? ""),
  "review-feedback": (tally, entry) => {
    answerKey(tally, text(entry, "resolves") ?? "");
  },
};

export interface Facts {
  readonly hold: Hold | undefined;
  readonly occurrences: number;
  readonly inPipeline: boolean;
  readonly mergeApproved: boolean;
  readonly awaitingMerge: boolean;
}

export function factsFrom(entries: readonly Entry[]): Facts {
  const tally: Tally = {
    hold: undefined,
    occurrences: 0,
    mergeApproved: false,
    awaitingMerge: false,
    inPipeline: false,
  };
  for (const entry of entries) ENTRY_EFFECTS[entry.kind]?.(tally, entry);
  return { ...tally };
}

export interface Finish {
  readonly merged: boolean;
  readonly workerDone: boolean;
  readonly at: number;
}

const HANDOFF_REPORTS: ReadonlySet<string> = new Set([...HANDOFFS, "in-review", "done"]);

const isMerge = (entry: Entry): boolean =>
  entry.kind === "finding" && text(entry, "condition") === "pr-merged";

export function finishFrom(entries: readonly Entry[]): Finish {
  const finish = { merged: false, workerDone: false, at: 0 };
  for (const entry of entries) {
    const status = text(entry, "status");
    if (isMerge(entry)) {
      finish.merged = true;
      finish.at = entry.createdAt;
    } else if (entry.kind === "comment") {
      finish.workerDone = false;
    } else if (entry.kind === "report" && status !== undefined && HANDOFF_REPORTS.has(status)) {
      finish.workerDone = status === "done";
      if (finish.workerDone) finish.at = entry.createdAt;
    }
  }
  return finish;
}
