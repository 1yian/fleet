// Kanban (spec section 21.2): one column for each status in flow order, one
// swimlane for each lane. Waiting sits at the side; Dropped is hidden.
import type { Board, Card, Status } from "@fleet/protocol";

const FLOW: readonly { status: Status | "with"; label: string }[] = [
  { status: "queued", label: "Queued" },
  { status: "working", label: "Working" },
  { status: "in-review", label: "In review" },
  { status: "with", label: "With mate" },
  { status: "needs-you", label: "Needs you" },
  { status: "merging", label: "Merging" },
  { status: "done", label: "Done" },
  { status: "waiting", label: "Waiting" },
];

const inColumn = (card: Card, column: Status | "with"): boolean =>
  column === "with"
    ? card.status === "with-mate" || card.status === "with-first-mate"
    : card.status === column;

export function Kanban({
  board,
  onOpen,
}: {
  readonly board: Board;
  readonly onOpen: (card: number) => void;
}) {
  const lanes = [...new Set(board.cards.map((card) => card.lane))].sort();
  return (
    <div className="kanban" role="table" aria-label="Kanban">
      <div className="row head" role="row">
        <span role="columnheader">Lane</span>
        {FLOW.map((column) => (
          <span role="columnheader" key={column.status}>
            {column.label}
          </span>
        ))}
      </div>
      {lanes.map((lane) => (
        <div className="row" role="row" key={lane}>
          <span role="rowheader" className="lane">
            {lane}
          </span>
          {FLOW.map((column) => (
            <div role="cell" className="cell" key={column.status}>
              {board.cards
                .filter((card) => card.lane === lane && inColumn(card, column.status))
                .map((card) => (
                  <button
                    type="button"
                    className="tile"
                    key={card.id}
                    onClick={() => {
                      onOpen(card.id);
                    }}
                  >
                    <b>c-{card.id}</b> {card.title}
                    {card.status === "with-first-mate" ? <em> · first mate</em> : null}
                  </button>
                ))}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
