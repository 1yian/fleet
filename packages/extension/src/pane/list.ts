import { quietFirst, type BoardCard, type Pulse } from "@fleet/protocol";

export interface Listed {
  readonly card: BoardCard;
  readonly pulse: Pulse;
}

export interface List {
  readonly heading: string;
  readonly rows: readonly Listed[];
  readonly running: readonly Listed[];
}

const pulsed = (cards: readonly BoardCard[]): Listed[] =>
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
