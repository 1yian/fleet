import type { BoardCard, Status } from "@fleet/protocol";

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

export interface Limits {
  readonly stallMs: number;
  readonly lostMs: number;
}

const WORKING: ReadonlySet<Status> = new Set(["working", "in-review"]);
const DOWN: ReadonlySet<string> = new Set(["starting", "exited", "lost"]);

const need = (card: BoardCard, kind: Kind, why: string, since: number): Need => ({
  kind,
  card: card.id,
  title: card.title,
  why,
  since,
});

export const unreachable = (since: number): Need => ({
  kind: "broken",
  card: undefined,
  title: "cardd",
  why: "not answering",
  since,
});

function liveNeed(card: BoardCard, now: number, limits: Limits): Need | undefined {
  const live = card.activity;
  if (card.mate || live === null || !WORKING.has(card.status)) return undefined;
  const quiet = now - live.at;
  if (DOWN.has(live.state) && quiet >= limits.lostMs)
    return need(card, "broken", "worker not connected", live.at);
  if (live.state === "running" && quiet >= limits.stallMs)
    return need(card, "stalled", "no output", live.at);
  return undefined;
}

function reportedNeed(card: BoardCard, now: number, limits: Limits): Need | undefined {
  if (card.attention === "failed") return need(card, "broken", "worker failed", card.updatedAt);
  if (card.attention === null || now - card.updatedAt < limits.stallMs) return undefined;
  return need(card, "stalled", `worker ${card.attention}`, card.updatedAt);
}

function needOf(card: BoardCard, now: number, limits: Limits): Need | undefined {
  if (card.status === "needs-you") return need(card, "needs-you", "needs you", card.updatedAt);
  return reportedNeed(card, now, limits) ?? liveNeed(card, now, limits);
}

const worstFirst = (a: Need, b: Need): number =>
  KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) || a.since - b.since;

const landedSince = (card: BoardCard, since: number): boolean =>
  card.status === "done" && !card.mate && card.kind !== "standing" && card.updatedAt > since;

export const withNeed = (glance: Glance, extra: Need): Glance => ({
  ...glance,
  needs: [...glance.needs, extra].sort(worstFirst),
});

export function glanceOf(
  cards: readonly BoardCard[],
  now: number,
  since: number,
  limits: Limits,
): Glance {
  return {
    needs: cards.flatMap((card) => needOf(card, now, limits) ?? []).sort(worstFirst),
    landed: cards.filter((card) => landedSince(card, since)).length,
  };
}
