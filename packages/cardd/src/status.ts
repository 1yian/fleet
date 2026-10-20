// Card status transitions (spec section 7.3) and their guards (section 7.4).
// Pure: the facts come from the card and its entries.
import {
  MERGE_OPTIONS,
  type CardKind,
  type Entry,
  type ReportStatus,
  type Status,
} from "@fleet/protocol";

export interface CardFacts {
  readonly status: Status;
  readonly kind: CardKind;
  readonly openAsks: number;
  readonly openDecisions: ReadonlySet<string>;
  readonly inPipeline: boolean;
  /** Whether the card's latest merge question was answered with approval. */
  readonly mergeApproved: boolean;
  /** Whether the card's grant covers merging (spec section 18). */
  readonly mergeGranted: boolean;
}

/** Changes whose new status depends on nothing else. */
const FIXED = {
  dispatch: "working",
  finding: "with-mate",
  handback: "with-mate",
  hold: "waiting",
  merged: "merging",
  cleanup: "done",
  drop: "dropped",
} as const satisfies Record<string, Status>;
interface FixedChange {
  readonly kind: keyof typeof FIXED;
}

export type Change =
  | FixedChange
  | { readonly kind: "ask"; readonly toFirstMate: boolean }
  | { readonly kind: "answer"; readonly merge?: "approve" | "changes" }
  | { readonly kind: "unhold"; readonly to: Status }
  | { readonly kind: "report"; readonly status: ReportStatus }
  | { readonly kind: "comment"; readonly resolves: string | undefined };

const isFixed = (change: Change): change is FixedChange => Object.hasOwn(FIXED, change.kind);

const CLOSED: ReadonlySet<Status> = new Set(["done", "dropped"]);
const HANDOFFS: ReadonlySet<ReportStatus> = new Set([
  "blocked",
  "needs-decision",
  "failed",
  "stopped",
]);

/** The status after a change, or the reason that a guard rejects it. */
export function nextStatus(card: CardFacts, change: Change): Status | Error {
  return CLOSED.has(card.status) ? new Error(`card is ${card.status}`) : byKind(card, change);
}

function byKind(card: CardFacts, change: Change): Status {
  if (isFixed(change)) return FIXED[change.kind];
  switch (change.kind) {
    case "ask":
      return afterAsk(change.toFirstMate);
    case "answer":
      return afterAnswer(card, change.merge);
    case "unhold":
      return change.to;
    case "report":
      return afterReport(card, change.status);
    case "comment":
      return afterComment(card, change.resolves);
  }
}

/** A second mate's question goes to main first. Every other question goes to the captain. */
const afterAsk = (toFirstMate: boolean): Status => (toFirstMate ? "with-first-mate" : "needs-you");

/** While another question is open the card stays. The last answer decides: merge approval goes to Merging, requested changes to Working. */
function afterAnswer(card: CardFacts, merge: "approve" | "changes" | undefined): Status {
  if (card.openAsks > 1) return card.status;
  if (merge === "changes") return "working";
  return merge === "approve" || card.mergeApproved ? "merging" : "with-mate";
}

function afterReport(card: CardFacts, status: ReportStatus): Status {
  if (card.status === "needs-you" && card.openAsks > 0) return card.status;
  if (status === "in-review") return "in-review";
  if (status === "done")
    return card.kind !== "ship" ? "with-mate" : card.mergeGranted ? "merging" : "needs-you";
  return HANDOFFS.has(status) ? "with-mate" : card.status;
}

function afterComment(card: CardFacts, resolves: string | undefined): Status {
  if (card.status !== "with-mate") return card.status;
  const open = new Set(card.openDecisions);
  if (resolves !== undefined) open.delete(resolves);
  if (open.size > 0) return card.status;
  return card.inPipeline ? "in-review" : "working";
}

const text = (entry: Entry, key: string): string | undefined => {
  const value = entry.fields[key];
  return typeof value === "string" ? value : undefined;
};

interface Tally {
  mergeAsk: string | undefined;
  mergeApproved: boolean;
  readonly asks: Set<string>;
  readonly decisions: Set<string>;
  inPipeline: boolean;
}

const REPORT_EFFECTS: Partial<Record<string, (tally: Tally, key: string) => void>> = {
  "needs-decision": (tally, key) => tally.decisions.add(key),
  resolved: (tally, key) => tally.decisions.delete(key),
  "in-review": (tally) => (tally.inPipeline = true),
  done: (tally) => (tally.inPipeline = false),
  failed: (tally) => (tally.inPipeline = false),
};

const ENTRY_EFFECTS: Partial<Record<string, (tally: Tally, entry: Entry) => void>> = {
  ask: (tally, entry) => {
    tally.asks.delete(text(entry, "resolves") ?? "");
    tally.asks.add(String(entry.id));
    if (entry.fields["merge"] === true) {
      tally.mergeAsk = String(entry.id);
      tally.mergeApproved = false;
    }
  },
  answer: (tally, entry) => {
    const resolves = text(entry, "resolves");
    tally.asks.delete(resolves ?? "");
    if (resolves !== undefined && resolves === tally.mergeAsk)
      tally.mergeApproved = text(entry, "choice") === MERGE_OPTIONS[0];
  },
  note: (tally, entry) => tally.asks.delete(text(entry, "resolves") ?? ""),
  comment: (tally, entry) => tally.decisions.delete(text(entry, "resolves") ?? ""),
  report: (tally, entry) =>
    REPORT_EFFECTS[text(entry, "status") ?? ""]?.(tally, text(entry, "key") ?? ""),
};

/** Open asks, open decision keys, and whether a pipeline runs, from a card's entries in order. */
export function factsFrom(
  entries: readonly Entry[],
): Omit<CardFacts, "status" | "kind" | "mergeGranted"> & { readonly askIds: readonly string[] } {
  const tally: Tally = {
    mergeAsk: undefined,
    mergeApproved: false,
    asks: new Set(),
    decisions: new Set(),
    inPipeline: false,
  };
  for (const entry of entries) ENTRY_EFFECTS[entry.kind]?.(tally, entry);
  return {
    openAsks: tally.asks.size,
    askIds: [...tally.asks],
    openDecisions: tally.decisions,
    inPipeline: tally.inPipeline,
    mergeApproved: tally.mergeApproved,
  };
}
