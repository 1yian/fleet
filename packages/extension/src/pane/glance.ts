import type { BoardCard, Pulse } from "@fleet/protocol";

export const KINDS = ["broken", "needs-you", "stalled"] as const;
export type Kind = (typeof KINDS)[number];

export interface Need {
  readonly kind: Kind;
  readonly card: number | undefined;
  readonly title: string;
  readonly why: string;
  readonly since: number;
}

export interface Glance {
  readonly needs: readonly Need[];
  readonly landed: number;
}

export function kindOf({ state, notice }: Pulse): Kind | undefined {
  if (state === "you") return "needs-you";
  if (state === "broken" || notice === "urgent") return "broken";
  return state === "stalled" || notice === "captain" ? "stalled" : undefined;
}

export const unreachable = (since: number): Need => ({
  kind: "broken",
  card: undefined,
  title: "cardd",
  why: "not answering",
  since,
});

const QUIET: Readonly<Partial<Record<Pulse["state"], string>>> = {
  you: "needs you",
  idle: "idle, nothing running",
  parked: "parked, nothing running",
};

function whyOf(card: BoardCard, { state }: Pulse): string {
  const quiet = QUIET[state];
  if (quiet !== undefined) return quiet;
  if (card.attention !== null) return `worker ${card.attention}`;
  return state === "broken" ? "worker not connected" : "no output";
}

function needOf(card: BoardCard): Need | undefined {
  const { pulse } = card;
  const kind = pulse === null ? undefined : kindOf(pulse);
  if (pulse === null || kind === undefined) return undefined;
  return { kind, card: card.id, title: card.title, why: whyOf(card, pulse), since: pulse.since };
}

const worstFirst = (a: Need, b: Need): number =>
  KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) || a.since - b.since;

const landedSince = (card: BoardCard, since: number): boolean =>
  card.status === "done" && !card.mate && card.kind !== "standing" && card.updatedAt > since;

export function glanceOf(cards: readonly BoardCard[], since: number): Glance {
  return {
    needs: cards.flatMap((card) => needOf(card) ?? []).sort(worstFirst),
    landed: cards.filter((card) => landedSince(card, since)).length,
  };
}
