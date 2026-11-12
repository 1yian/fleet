import type { Decision } from "./decisions.ts";

const LOOK = "Read it, then press ⏎.";
const ARRIVED = "A new decision is on screen.";

export interface Slot {
  readonly decision: Decision;
  readonly answered: boolean;
}

export interface Merged {
  readonly deck: Slot[];
  readonly at: number;
  readonly stayed: boolean;
  readonly arrival: string | undefined;
}

export function openAway(deck: readonly Slot[], at: number, step: number): number | undefined {
  const count = deck.length;
  for (let away = 1; away < count; away += 1) {
    const to = (((at + step * away) % count) + count) % count;
    if (deck[to]?.answered === false) return to;
  }
  return undefined;
}

function slotOf(old: Slot, now: Decision | undefined): Slot | undefined {
  const open: Slot | undefined = now === undefined ? undefined : { decision: now, answered: false };
  if (!old.answered) return open;
  return now !== undefined && now.hold > old.decision.hold ? open : old;
}

function arrivalOf(
  shown: Slot | undefined,
  before: Slot | undefined,
  stayed: boolean,
): string | undefined {
  if (shown === undefined || shown.answered) return undefined;
  if (!stayed) return `${ARRIVED} ${LOOK}`;
  const changed = shown.decision.hold !== before?.decision.hold;
  return changed ? `c-${String(shown.decision.card)} changed. ${LOOK}` : undefined;
}

function stayingAt(next: readonly Slot[], current: Slot | undefined): number {
  if (current === undefined || current.answered) return -1;
  return next.findIndex((slot) => !slot.answered && slot.decision.card === current.decision.card);
}

export function merged(deck: readonly Slot[], at: number, fresh: readonly Decision[]): Merged {
  const waiting = new Map(fresh.map((each) => [each.card, each]));
  const next: Slot[] = [];
  let landing = -1;
  deck.forEach((old, place) => {
    const slot = slotOf(old, waiting.get(old.decision.card));
    if (slot === undefined) return;
    if (landing === -1 && !slot.answered && place >= at) landing = next.length;
    next.push(slot);
  });
  const held = new Set(next.map((slot) => slot.decision.card));
  for (const decision of fresh)
    if (!held.has(decision.card)) next.push({ decision, answered: false });
  const staying = stayingAt(next, deck[at]);
  const first = next.findIndex((slot) => !slot.answered);
  const to = Math.max(0, staying !== -1 ? staying : landing !== -1 ? landing : first);
  const arrival = arrivalOf(next[to], deck[at], staying !== -1);
  return { deck: next, at: to, stayed: staying !== -1, arrival };
}
