import { quietFirst, type BoardCard, type Pulse } from "@fleet/protocol";

export interface Open {
  readonly card: BoardCard;
  readonly pulse: Pulse;
}

interface Landed {
  readonly card: BoardCard;
  readonly pulse: null;
}

export type Listed = Open | Landed;

export interface List {
  readonly heading: string;
  readonly rows: readonly Listed[];
  readonly running: readonly Open[];
}

const pulsed = (cards: readonly BoardCard[]): Open[] =>
  cards
    .flatMap((card) => (card.pulse === null ? [] : [{ card, pulse: card.pulse }]))
    .sort((a, b) => quietFirst(a.pulse, b.pulse) || a.card.id - b.card.id);

export function listOf(cards: readonly BoardCard[]): List {
  const open = pulsed(cards);
  return {
    heading: `Pulse · ${String(open.length)} open · quiet first`,
    rows: open.filter(({ pulse }) => pulse.state !== "running"),
    running: open.filter(({ pulse }) => pulse.state === "running"),
  };
}

export function listOfCounted(cards: readonly BoardCard[], heading: string): List {
  return { heading, rows: pulsed(cards), running: [] };
}

export function listOfLanded(cards: readonly BoardCard[], heading: string): List {
  const rows: Landed[] = cards
    .map((card) => ({ card, pulse: null }))
    .sort((a, b) => b.card.updatedAt - a.card.updatedAt || a.card.id - b.card.id);
  return { heading, rows, running: [] };
}
