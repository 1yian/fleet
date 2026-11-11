import { useState, type MouseEvent } from "react";
import {
  PULSE_WORDS,
  quietFirst,
  runningText,
  waitsText,
  type BoardCard,
  type Pulse,
  type PulseState,
} from "@fleet/protocol";
import { age } from "./format.ts";
import { idLabel } from "./text.ts";

const SHOWN = 5;
const CHIPS: readonly PulseState[] = ["broken", "stalled", "idle", "parked", "you"];

interface Flagged {
  readonly card: BoardCard;
  readonly pulse: Pulse;
}

export const alarming = ({ state, notice }: Pulse): boolean =>
  state === "broken" || state === "stalled" || notice === "captain" || notice === "urgent";

const flagged = (pulse: Pulse): boolean => pulse.state === "you" || alarming(pulse);

function flaggedIn(cards: readonly BoardCard[]): Flagged[] {
  return cards
    .flatMap((card) => (card.mate || card.pulse === null ? [] : [{ card, pulse: card.pulse }]))
    .filter(({ pulse }) => flagged(pulse))
    .sort((a, b) => quietFirst(a.pulse, b.pulse) || a.card.id - b.card.id);
}

export const toneOf = (pulse: Pulse): "you" | "red" | "amber" => {
  if (pulse.state === "you") return "you";
  return pulse.state === "broken" || pulse.notice === "urgent" ? "red" : "amber";
};

export function heldText(pulse: Pulse, now: number): string {
  const held = age(pulse.since, now);
  return held === "now" ? PULSE_WORDS[pulse.state] : `${PULSE_WORDS[pulse.state]} ${held}`;
}

const opens = (event: MouseEvent): boolean =>
  event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey;

function reasonOf({ card, pulse }: Flagged): string {
  if (pulse.state === "you") return card.summary;
  return `${waitsText(card)} · running ${runningText(card)}`;
}

function Item(props: {
  readonly item: Flagged;
  readonly now: number;
  readonly onOpen: (card: number) => void;
}) {
  const { item, now } = props;
  const { card, pulse } = item;
  return (
    <li className={`attention-item ${toneOf(pulse)}`} data-state={pulse.state}>
      <span className="what">{heldText(pulse, now)}</span>
      <a
        className="title"
        href={`#/c-${String(card.id)}`}
        onClick={(event) => {
          if (!opens(event)) return;
          event.preventDefault();
          props.onOpen(card.id);
        }}
      >
        <span className="id">{idLabel(card.id)}</span> {card.title}
      </a>
      <span className="lane">{card.lane}</span>
      <span className="why">{reasonOf(item)}</span>
    </li>
  );
}

export function Attention(props: {
  readonly cards: readonly BoardCard[];
  readonly now: number;
  readonly onOpen: (card: number) => void;
}) {
  const [all, setAll] = useState(false);
  const items = flaggedIn(props.cards);
  if (items.length === 0) return null;
  const shown = all ? items : items.slice(0, SHOWN);
  return (
    <section className="attention" aria-label="Attention">
      <header className="attention-head">
        <h2>Attention</h2>
        {CHIPS.map((state) => {
          const count = items.filter(({ pulse }) => pulse.state === state).length;
          return count === 0 ? null : (
            <span key={state} className={`attention-chip ${state}`}>
              <span className="n">{count}</span> {PULSE_WORDS[state].toLowerCase()}
            </span>
          );
        })}
      </header>
      <ol className="attention-list">
        {shown.map((item) => (
          <Item key={item.card.id} item={item} now={props.now} onOpen={props.onOpen} />
        ))}
      </ol>
      {items.length > SHOWN ? (
        <button
          type="button"
          className="show-more"
          aria-expanded={all}
          onClick={() => {
            setAll(!all);
          }}
        >
          {all ? "Show fewer" : `${String(items.length - SHOWN)} more`}
        </button>
      ) : null}
    </section>
  );
}
