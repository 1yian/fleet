// One card in the inbox: its title, its latest news, and its status. A question
// for the captain shows with its answers, so one click answers it. A click on the
// card opens its detail.
import type { MouseEvent } from "react";
import type { BoardCard } from "@fleet/protocol";
import { Ask } from "./Ask.tsx";
import { isActive, statusLine, toneOf, type Question } from "./format.ts";
import { Sparkle, StatusIcon } from "./icons.tsx";

interface Props {
  readonly card: BoardCard;
  readonly questions: readonly Question[];
  /** Whether number keys answer this card's first question. */
  readonly keys: boolean;
  readonly now: number;
  readonly onOpen: () => void;
  readonly onAnswer: (ask: number, choice: string, written: boolean) => Promise<boolean>;
}

/** A click on the card opens it, unless the click was meant for a control inside it. */
const onControl = (event: MouseEvent): boolean =>
  event.target instanceof Element && event.target.closest("a, button, textarea, input") !== null;

export function TaskCard(props: Props) {
  const { card, questions, keys, now } = props;
  const asked = questions.length > 0;
  const tone = toneOf(card, asked);
  return (
    <article
      className={`task ${tone}`}
      aria-label={card.title}
      onClick={(event) => {
        if (!onControl(event)) props.onOpen();
      }}
    >
      <a
        className="task-head"
        href={`#/c-${String(card.id)}`}
        onClick={(event) => {
          // A new tab or window keeps the link's own address.
          if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
          event.preventDefault();
          props.onOpen();
        }}
      >
        <Sparkle />
        <span className="task-title">{card.title}</span>
        {card.summary === "" ? null : <span className="task-summary">{card.summary}</span>}
      </a>
      <p className="task-status">
        <StatusIcon tone={tone} active={isActive(card)} />
        <span className="task-phrase">{statusLine(card, asked, now)}</span>
        {card.mate ? null : <span className="tag">{card.lane}</span>}
        {card.pr === null ? null : (
          <a className="tag link" href={card.pr} target="_blank" rel="noreferrer">
            PR
          </a>
        )}
      </p>
      {questions.map((question, index) => (
        <Ask
          key={question.ask}
          question={question}
          keys={keys && index === 0}
          onAnswer={props.onAnswer}
        />
      ))}
    </article>
  );
}
