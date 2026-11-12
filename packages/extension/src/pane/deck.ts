import type { Decision } from "./decisions.ts";

export interface Slot {
  readonly decision: Decision;
  readonly answered: boolean;
}

export interface Merged {
  readonly deck: readonly Slot[];
  readonly at: number;
  readonly same: boolean;
}

export function openAway(deck: readonly Slot[], at: number, step: number): number | undefined {
  const count = deck.length;
  for (let away = 1; away < count; away += 1) {
    const to = (((at + step * away) % count) + count) % count;
    if (deck[to]?.answered === false) return to;
  }
  return undefined;
}

export function merged(
  deck: readonly Slot[],
  fresh: readonly Decision[],
  refused: Decision,
  at: number,
): Merged {
  const waiting = new Map(fresh.map((each) => [each.card, each]));
  const kept = new Set<number>();
  const next: Slot[] = [];
  let landing = -1;
  deck.forEach((slot, place) => {
    const decision = slot.answered ? slot.decision : waiting.get(slot.decision.card);
    if (decision === undefined) return;
    if (!slot.answered) kept.add(decision.card);
    if (landing === -1 && !slot.answered && place >= at) landing = next.length;
    next.push({ decision, answered: slot.answered });
  });
  for (const decision of fresh)
    if (!kept.has(decision.card)) next.push({ decision, answered: false });
  const same = next.findIndex((slot) => !slot.answered && slot.decision.card === refused.card);
  const first = next.findIndex((slot) => !slot.answered);
  const landed = Math.max(0, same !== -1 ? same : landing !== -1 ? landing : first);
  return { deck: next, at: landed, same: same !== -1 };
}
