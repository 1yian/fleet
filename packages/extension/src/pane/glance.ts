import type { BoardCard, Pulse } from "@fleet/protocol";

export const KINDS = ["broken", "needs-you", "stalled"] as const;
export type Kind = (typeof KINDS)[number];

export interface Glance {
  readonly counts: Readonly<Record<Kind, number>>;
  readonly landed: number;
}

export function kindOf({ state, notice }: Pulse): Kind | undefined {
  if (state === "you") return "needs-you";
  if (state === "broken" || notice === "urgent") return "broken";
  return state === "stalled" || notice !== "none" ? "stalled" : undefined;
}

const isDecision = (card: BoardCard): boolean => card.status === "needs-you";

const countedKind = (card: BoardCard): Kind | undefined => {
  const kind = card.pulse === null ? undefined : kindOf(card.pulse);
  return kind === "needs-you" && isDecision(card) ? undefined : kind;
};

const landedSince = (card: BoardCard, since: number): boolean =>
  card.status === "done" && !card.mate && card.kind !== "standing" && card.updatedAt > since;

export function glanceOf(cards: readonly BoardCard[], since: number): Glance {
  const kinds = cards.flatMap((card) => countedKind(card) ?? []);
  const count = (kind: Kind): number => kinds.filter((each) => each === kind).length;
  return {
    counts: { broken: count("broken"), "needs-you": count("needs-you"), stalled: count("stalled") },
    landed: cards.filter((card) => landedSince(card, since)).length,
  };
}
