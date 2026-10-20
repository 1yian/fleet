// Card status (spec sections 7 and 17). A card has a phase, where its work stands, and at
// most one hold. Its status is derived: the phase seen through the hold. No operation sets
// a status. Pure: the facts come from the card and its entries.
import {
  HOLDERS,
  MERGE_OPTIONS,
  type CardKind,
  type Entry,
  type Holder,
  type ReportStatus,
  type Status,
} from "@fleet/protocol";

/** Where a card's work stands, whatever holds it. */
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

/**
 * A card's hold: the one gate that it waits at. It bundles every question that the gate
 * holds, and it names who it waits on now. Each time the card is held again after a release,
 * that is a new occurrence of the same hold.
 */
export interface Hold {
  readonly occurrence: number;
  readonly holder: Holder;
  readonly question: string;
  readonly options: readonly string[];
  readonly merge: boolean;
  /** The decision keys of the worker that it carries. */
  readonly keys: readonly string[];
  /** Whether a worker's decision opened it. It ends when the worker's keys are all answered. */
  readonly fromWorker: boolean;
  readonly until: number | null;
  /** The entry that wrote the hold as it stands. */
  readonly entry: number;
}

export interface CardFacts {
  readonly phase: Phase;
  readonly kind: CardKind;
  readonly hold: Hold | undefined;
  readonly inPipeline: boolean;
  /** Whether the card's grant covers merging (spec section 18). */
  readonly mergeGranted: boolean;
}

/** Changes whose new phase depends on nothing else. */
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
  /** A hold began, changed, or ended its date: the phase stays, and the status follows the hold. */
  | { readonly kind: "held" }
  | { readonly kind: "released"; readonly outcome?: "approve" | "changes" | "withdrawn" }
  | { readonly kind: "report"; readonly status: ReportStatus }
  | { readonly kind: "comment" };

const isFixed = (change: Change): change is FixedChange => Object.hasOwn(FIXED, change.kind);

const CLOSED: ReadonlySet<Phase> = new Set(["done", "dropped"]);
const HANDOFFS: ReadonlySet<ReportStatus> = new Set([
  "blocked",
  "needs-decision",
  "failed",
  "stopped",
]);

/** The phase after a change, or the reason that a guard rejects it. */
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
      return afterComment(card);
  }
}

/** The captain's merge answer decides: approval goes to Merging, requested changes to Working. Anything else goes to the mate, who acts on it. A withdrawn question changes nothing. */
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
    return card.kind !== "ship" || !card.mergeGranted ? "with-mate" : "merging";
  return HANDOFFS.has(status) ? "with-mate" : card.phase;
}

/** A mate's comment sends the worker back to work, unless a decision key of the worker is still open. */
function afterComment(card: CardFacts): Phase {
  if (card.phase !== "with-mate" || (card.hold?.keys.length ?? 0) > 0) return card.phase;
  return card.inPipeline ? "in-review" : "working";
}

/**
 * The status of a card: its phase seen through its hold. A hold that waits on the captain
 * makes the card Needs you. A hold that waits on a mate makes it With mate. A hold with a
 * date in the future is Waiting until then. A closed card has no hold.
 */
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
  /** Whether the worker's latest word is done, and nothing has reopened the work since. */
  awaitingMerge: boolean;
  inPipeline: boolean;
}

/** Writes a hold, or writes it again: the occurrence, the keys, and the worker's origin stay. */
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

/** A worker's decision opens the card's hold, or adds its key to the hold that is open. */
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

/** A worker's key is answered. A hold that a worker opened ends with its last key. */
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
      // The captain's steer takes the hold back from him: its owner decides what it does.
      if (tally.hold?.holder === "captain") tally.hold = { ...tally.hold, holder: "owner" };
    } else {
      tally.awaitingMerge = false;
      answerKey(tally, text(entry, "resolves") ?? "");
    }
  },
  report: (tally, entry) =>
    REPORT_EFFECTS[text(entry, "status") ?? ""]?.(tally, entry, text(entry, "key") ?? ""),
};

export interface Facts {
  readonly hold: Hold | undefined;
  readonly occurrences: number;
  readonly inPipeline: boolean;
  readonly mergeApproved: boolean;
  readonly awaitingMerge: boolean;
}

/** The hold, the pipeline, and the merge approval of a card, from its entries in order. */
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
