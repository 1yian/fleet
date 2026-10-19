// Card status transitions (spec section 7.3) and their guards (section 7.4).
// Pure: the facts come from the card and its entries.
import type { CardKind, Entry, ReportStatus, Status } from "@fleet/protocol";

export interface CardFacts {
  readonly status: Status;
  readonly kind: CardKind;
  readonly openAsks: number;
  readonly openDecisions: ReadonlySet<string>;
  readonly inPipeline: boolean;
}

export type Change =
  | { readonly kind: "dispatch" }
  | { readonly kind: "report"; readonly status: ReportStatus }
  | { readonly kind: "comment"; readonly resolves: string | undefined };

const CLOSED: ReadonlySet<Status> = new Set(["done", "dropped"]);
const HANDOFFS: ReadonlySet<ReportStatus> = new Set([
  "blocked",
  "needs-decision",
  "failed",
  "stopped",
]);

/** The status after a change, or the reason that a guard rejects it. */
export function nextStatus(card: CardFacts, change: Change): Status | Error {
  if (CLOSED.has(card.status)) return new Error(`card is ${card.status}`);
  switch (change.kind) {
    case "dispatch":
      return "working";
    case "report":
      return afterReport(card, change.status);
    case "comment":
      return afterComment(card, change.resolves);
  }
}

function afterReport(card: CardFacts, status: ReportStatus): Status {
  if (card.status === "needs-you" && card.openAsks > 0) return card.status;
  if (status === "in-review") return "in-review";
  if (status === "done") return card.kind === "ship" ? "needs-you" : "with-mate";
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
  ask: (tally, entry) => tally.asks.add(String(entry.id)),
  answer: (tally, entry) => tally.asks.delete(text(entry, "resolves") ?? ""),
  comment: (tally, entry) => tally.decisions.delete(text(entry, "resolves") ?? ""),
  report: (tally, entry) =>
    REPORT_EFFECTS[text(entry, "status") ?? ""]?.(tally, text(entry, "key") ?? ""),
};

/** Open asks, open decision keys, and whether a pipeline runs, from a card's entries in order. */
export function factsFrom(entries: readonly Entry[]): Omit<CardFacts, "status" | "kind"> {
  const tally: Tally = { asks: new Set(), decisions: new Set(), inPipeline: false };
  for (const entry of entries) ENTRY_EFFECTS[entry.kind]?.(tally, entry);
  return {
    openAsks: tally.asks.size,
    openDecisions: tally.decisions,
    inPipeline: tally.inPipeline,
  };
}
