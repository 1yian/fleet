// The inbox (spec section 21.2): Needs you, Running, and Done, as three columns
// (Board) or one after another (List), and Mates under them. A narrow screen always gets the list.
// A click on a card opens its detail.
import type { Board } from "@fleet/protocol";
import { groups, questionsByCard } from "./format.ts";
import { Sparkle } from "./icons.tsx";
import { TaskCard } from "./TaskCard.tsx";

export type View = "board" | "list";

interface Props {
  readonly board: Board;
  readonly view: View;
  readonly now: number;
  readonly onOpen: (card: number) => void;
  readonly onAnswer: (
    card: number,
    hold: number,
    choice: string,
    written: boolean,
  ) => Promise<boolean>;
}

export function Inbox(props: Props) {
  const { board, view } = props;
  const asked = questionsByCard(board.holds);
  const { needs, running, done, mates } = groups(board.cards, asked);
  const sections = [
    { tone: "needs", label: "Needs you", cards: needs, empty: "Nothing waits on you." },
    { tone: "running", label: "Running", cards: running, empty: "Nothing is running." },
    { tone: "done", label: "Done", cards: done, empty: "Nothing has finished yet." },
    // Main and each second mate talk on its lane card. There is no section without a mate.
    ...(mates.length === 0 ? [] : [{ tone: "mates", label: "Mates", cards: mates, empty: "" }]),
  ];
  // Number keys answer the first question on the board.
  const keyed = board.holds[0]?.card;
  return (
    <div className="inbox" data-view={view}>
      {sections.map((section) => (
        <section key={section.tone} className={`group ${section.tone}`} aria-label={section.label}>
          <header className="group-head">
            <Sparkle />
            <h2>{section.label}</h2>
            <span className="count">{section.cards.length}</span>
          </header>
          {section.cards.length === 0 ? <p className="empty">{section.empty}</p> : null}
          {section.cards.map((card) => (
            <TaskCard
              key={card.id}
              card={card}
              questions={asked.get(card.id) ?? []}
              keys={card.id === keyed}
              now={props.now}
              onOpen={() => {
                props.onOpen(card.id);
              }}
              onAnswer={(hold, choice, written) => props.onAnswer(card.id, hold, choice, written)}
            />
          ))}
        </section>
      ))}
    </div>
  );
}
