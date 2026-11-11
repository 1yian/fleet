import { quietFirst, type BoardCard, type Pulse } from "@fleet/protocol";

export interface Listed {
  readonly card: BoardCard;
  readonly pulse: Pulse;
}

export interface List {
  readonly open: number;
  readonly rows: readonly Listed[];
  readonly running: readonly Listed[];
}

export function listOf(cards: readonly BoardCard[]): List {
  const open = cards
    .flatMap((card) => (card.pulse === null ? [] : [{ card, pulse: card.pulse }]))
    .sort((a, b) => quietFirst(a.pulse, b.pulse) || a.card.id - b.card.id);
  return {
    open: open.length,
    rows: open.filter(({ pulse }) => pulse.state !== "running"),
    running: open.filter(({ pulse }) => pulse.state === "running"),
  };
}
