import type { BoardCard, Pulse } from "@fleet/protocol";

export type Kind = "broken" | "own" | "stalled";

export const RAISED = ["broken", "stalled"] as const;
export type Raised = (typeof RAISED)[number];

export type Glance = Readonly<Record<Raised, readonly BoardCard[]>>;

export function kindOf({ state, notice }: Pulse): Kind | undefined {
  if (state === "you") return "own";
  if (state === "broken" || notice === "urgent") return "broken";
  return state === "stalled" || notice !== "none" ? "stalled" : undefined;
}

const raisedKind = (card: BoardCard): Raised | undefined => {
  const kind = card.pulse === null ? undefined : kindOf(card.pulse);
  return kind === "own" ? undefined : kind;
};

export function glanceOf(cards: readonly BoardCard[]): Glance {
  const of = (kind: Raised): readonly BoardCard[] =>
    cards.filter((card) => raisedKind(card) === kind);
  return { broken: of("broken"), stalled: of("stalled") };
}
