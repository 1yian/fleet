// The inbox (spec section 21.2): Needs you, Running, and Done, as three columns
// (Board) or one after another (List). A narrow screen always gets the list.
import type { Board } from "@fleet/protocol";
import { groups, questionsByCard } from "./format.ts";
import { Sparkle } from "./icons.tsx";
import { TaskCard } from "./TaskCard.tsx";

export type View = "board" | "list";

interface Props {
  readonly board: Board;
  readonly view: View;
  readonly open: number | undefined;
  readonly now: number;
  readonly changes: number;
  readonly onToggle: (card: number) => void;
  readonly onAnswer: (card: number, ask: number, choice: string) => void;
  readonly onReply: (card: number, text: string) => Promise<void>;
  readonly onFail: (message: string) => void;
}

export function Inbox(props: Props) {
  const { board, view, open } = props;
  const asked = questionsByCard(board.questions);
  const { needs, running, done } = groups(board.cards, asked);
  const sections = [
    { tone: "needs", label: "Needs you", cards: needs, empty: "Nothing waits on you." },
    { tone: "running", label: "Running", cards: running, empty: "Nothing is running." },
    { tone: "done", label: "Done", cards: done, empty: "Nothing has finished yet." },
  ];
  // Number keys answer the first question on the board.
  const keyed = board.questions[0]?.card;
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
              open={card.id === open}
              now={props.now}
              changes={props.changes}
              onToggle={() => {
                props.onToggle(card.id);
              }}
              onAnswer={(ask, choice) => {
                props.onAnswer(card.id, ask, choice);
              }}
              onReply={(text) => props.onReply(card.id, text)}
              onFail={props.onFail}
            />
          ))}
        </section>
      ))}
    </div>
  );
}
