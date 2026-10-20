// Needs you (spec section 21.2): every question that waits on the captain, in
// every lane, with its options inline. 1 to 9 answer the first question.
import { useEffect } from "react";
import type { Board } from "@fleet/protocol";

interface Props {
  readonly board: Board;
  readonly onAnswer: (card: number, ask: number, choice: string) => void;
  readonly onOpen: (card: number) => void;
}

const typesText = (element: HTMLElement): boolean =>
  element.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName);

export function NeedsYou({ board, onAnswer, onOpen }: Props) {
  const first = board.questions[0];
  useEffect(() => {
    const key = (event: KeyboardEvent): void => {
      if (first === undefined || event.repeat || event.metaKey || event.ctrlKey || event.altKey)
        return;
      if (event.target instanceof HTMLElement && typesText(event.target)) return;
      const choice = first.options[Number(event.key) - 1];
      if (choice !== undefined) onAnswer(first.card, first.ask, choice);
    };
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("keydown", key);
    };
  }, [first, onAnswer]);

  if (board.questions.length === 0) return <p className="empty">Nothing waits on you.</p>;
  return (
    <ul className="questions" aria-label="Needs you">
      {board.questions.map((question) => {
        const card = board.cards.find((each) => each.id === question.card);
        return (
          <li key={question.ask} className="question">
            <button
              type="button"
              className="card-link"
              onClick={() => {
                onOpen(question.card);
              }}
            >
              c-{question.card} · {card?.lane} · {card?.title}
            </button>
            <p>{question.question}</p>
            <div className="options">
              {question.options.map((option, index) => (
                <button
                  type="button"
                  key={option}
                  className={index === 0 ? "primary" : ""}
                  onClick={() => {
                    onAnswer(question.card, question.ask, option);
                  }}
                >
                  {question === first && index < 9 ? <kbd>{index + 1}</kbd> : null} {option}
                </button>
              ))}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
