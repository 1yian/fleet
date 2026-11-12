import type { BoardCard, Pulse } from "@fleet/protocol";

export const KINDS = ["broken", "own", "stalled"] as const;
export type Kind = (typeof KINDS)[number];

export interface Glance {
  readonly cards: Readonly<Record<Kind, readonly BoardCard[]>>;
  readonly landed: readonly BoardCard[];
}

export function kindOf({ state, notice }: Pulse): Kind | undefined {
  if (state === "you") return "own";
  if (state === "broken" || notice === "urgent") return "broken";
  return state === "stalled" || notice !== "none" ? "stalled" : undefined;
}

const isDecision = (card: BoardCard): boolean => card.status === "needs-you";

const countedKind = (card: BoardCard): Kind | undefined => {
  const kind = card.pulse === null ? undefined : kindOf(card.pulse);
  return kind === "own" && isDecision(card) ? undefined : kind;
};

const landedSince = (card: BoardCard, since: number): boolean =>
  card.status === "done" && !card.mate && card.kind !== "standing" && card.updatedAt > since;

export function glanceOf(cards: readonly BoardCard[], since: number): Glance {
  const of = (kind: Kind): readonly BoardCard[] =>
    cards.filter((card) => countedKind(card) === kind);
  return {
    cards: { broken: of("broken"), own: of("own"), stalled: of("stalled") },
    landed: cards.filter((card) => landedSince(card, since)),
  };
}
