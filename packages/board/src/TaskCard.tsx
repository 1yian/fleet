import type { MouseEvent } from "react";
import type { BoardCard, Status } from "@fleet/protocol";
import { Ask } from "./Ask.tsx";
import {
  age,
  doneLabel,
  glyphOf,
  laneColor,
  laterLabel,
  liveOf,
  mergingLabel,
  prLabel,
  withWho,
  type Facts,
  type Question,
} from "./format.ts";
import { Rich } from "./Rich.tsx";
import { Stale } from "./Stale.tsx";
import { idLabel } from "./text.ts";
import { ClockIcon, PrIcon, SpinnerIcon, StatusIcon } from "./icons.tsx";

interface Handlers {
  readonly onOpen: (card: number) => void;
  readonly onAnswer: (
    card: number,
    hold: number,
    choice: string,
    written: boolean,
  ) => Promise<boolean>;
  readonly onLater: (card: number, until: number, reason: string) => void;
  readonly onDismiss: (card: number) => void;
}

interface CardProps extends Handlers {
  readonly card: BoardCard;
  readonly question: Question | undefined;
  readonly facts: Facts | undefined;
  readonly notice: string | undefined;
  readonly now: number;
}

const onControl = (event: MouseEvent): boolean =>
  event.target instanceof Element && event.target.closest("a, button, textarea, input") !== null;

const opens = (event: MouseEvent): boolean =>
  event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey;

function TitleLink(props: { readonly card: BoardCard; readonly onOpen: () => void }) {
  return (
    <a
      className="title"
      href={`#/c-${String(props.card.id)}`}
      onClick={(event) => {
        if (!opens(event)) return;
        event.preventDefault();
        props.onOpen();
      }}
    >
      {props.card.title}
    </a>
  );
}

export function LaneAvatar({ lane }: { readonly lane: string }) {
  return (
    <span className="av" style={{ background: laneColor(lane) }} title={lane} aria-hidden="true">
      {lane.charAt(0)}
    </span>
  );
}

const worksNow = (card: BoardCard): boolean =>
  card.mate || card.status === "working" || card.status === "in-review";

export function LiveChip(props: {
  readonly card: BoardCard;
  readonly now: number;
  readonly always?: boolean;
}) {
  const { card, now } = props;
  if (card.activity === null) return null;
  if (card.activity.state === "idle" && !worksNow(card) && props.always !== true) return null;
  const live = liveOf(card.activity, now);
  return (
    <span className={`chip live ${live.tone}`} title="What the agent on this card is doing now">
      <span className="pulse" aria-hidden="true" />
      {live.text}
    </span>
  );
}

function PrChip({ url }: { readonly url: string }) {
  return (
    <a className="chip link" href={url} target="_blank" rel="noreferrer">
      <PrIcon />
      {prLabel(url)}
    </a>
  );
}

function StatusChip(props: {
  readonly card: BoardCard;
  readonly facts: Facts | undefined;
  readonly now: number;
}) {
  const { card, facts, now } = props;
  if (card.status === "in-review")
    return (
      <span className="chip working">
        <SpinnerIcon />
        validating
      </span>
    );
  if (card.status === "with-mate") return <span className="chip">with {withWho(card)}</span>;
  if (card.status === "waiting")
    return (
      <span className="chip">
        <ClockIcon />
        {facts?.until === undefined ? "Later" : laterLabel(facts.until, now)}
      </span>
    );
  if (card.status === "merging") return <span className="chip ghost">{mergingLabel(facts)}</span>;
  return null;
}

const GLANCE: Readonly<Partial<Record<Status, string>>> = {
  "in-review": "validating",
};

function OwedChip({ card }: { readonly card: BoardCard }) {
  if (card.replies.length === 0) return null;
  const owed = card.replies.map((each) => `${each.owes} owes ${each.from} a reply`).join("\n");
  return (
    <span className="chip owed" title={owed}>
      {card.replies.length === 1 ? "Reply owed" : `${String(card.replies.length)} replies owed`}
    </span>
  );
}

function glanceOf(card: BoardCard, facts: Facts | undefined, now: number): string {
  if (card.status === "waiting" && facts?.until !== undefined) return laterLabel(facts.until, now);
  if (card.status === "with-mate") return `with ${withWho(card)}`;
  if (card.activity !== null && card.status === "working") return liveOf(card.activity, now).text;
  if (card.pr !== null) return prLabel(card.pr);
  return GLANCE[card.status] ?? card.status;
}

const waiting = (from: number, now: number): string =>
  age(from, now) === "now" ? "just now" : `waiting ${age(from, now)}`;

function IdRow({
  card,
  asked,
  now,
}: {
  readonly card: BoardCard;
  readonly asked: boolean;
  readonly now: number;
}) {
  return (
    <div className="idrow">
      <span className="id">{idLabel(card.id)}</span>
      <span className="what">
        {card.kind} · {card.lane}
      </span>
      <span className={asked ? "age due" : "age"}>
        {asked ? waiting(card.updatedAt, now) : age(card.updatedAt, now)}
      </span>
    </div>
  );
}

function Hold(props: CardProps & { readonly question: Question; readonly open: () => void }) {
  const { card, question } = props;
  return (
    <Ask
      question={question}
      showQuestion={!(question.merge && card.pr !== null)}
      onRead={props.open}
      onAnswer={(hold, choice, written) => props.onAnswer(card.id, hold, choice, written)}
      onLater={(until, reason) => {
        props.onLater(card.id, until, reason);
      }}
    />
  );
}

export function TaskCard(props: CardProps) {
  const { card, question, facts, now } = props;
  const open = (): void => {
    props.onOpen(card.id);
  };
  const asked = question !== undefined;
  return (
    <article
      className={`card ${asked ? "needs" : `s-${card.status}`}`}
      aria-label={card.title}
      onClick={(event) => {
        if (!onControl(event)) open();
      }}
    >
      <IdRow card={card} asked={asked} now={now} />
      <h3 className="t">
        <StatusIcon glyph={glyphOf(card, asked)} />
        <TitleLink card={card} onOpen={open} />
        {asked ? null : <span className="glance">{glanceOf(card, facts, now)}</span>}
      </h3>
      {card.status === "with-mate" && card.summary !== "" ? (
        <p className="latest">
          <Rich text={card.summary} />
        </p>
      ) : null}
      <div className="meta">
        <StatusChip card={card} facts={facts} now={now} />
        <LiveChip card={card} now={now} />
        {card.pr === null ? null : <PrChip url={card.pr} />}
        <OwedChip card={card} />
      </div>
      {props.notice === undefined ? null : (
        <Stale
          text={props.notice}
          onDismiss={() => {
            props.onDismiss(card.id);
          }}
        />
      )}
      {question === undefined ? null : <Hold {...props} question={question} open={open} />}
    </article>
  );
}

export function DoneRow(props: {
  readonly card: BoardCard;
  readonly facts: Facts | undefined;
  readonly now: number;
  readonly onOpen: (card: number) => void;
}) {
  const { card } = props;
  const open = (): void => {
    props.onOpen(card.id);
  };
  const label = doneLabel(card, props.facts);
  return (
    <article
      className="done-row"
      aria-label={card.title}
      onClick={(event) => {
        if (!onControl(event)) open();
      }}
    >
      <StatusIcon glyph={glyphOf(card, false)} />
      <div className="done-body">
        <TitleLink card={card} onOpen={open} />
        <span className="sub">
          <span className="label">{label}</span>
          <span className="age">{age(card.updatedAt, props.now)}</span>
        </span>
      </div>
    </article>
  );
}

export function MateRow(props: {
  readonly card: BoardCard;
  readonly now: number;
  readonly onOpen: (card: number) => void;
}) {
  const { card } = props;
  const open = (): void => {
    props.onOpen(card.id);
  };
  return (
    <article
      className="mate-row"
      aria-label={card.title}
      onClick={(event) => {
        if (!onControl(event)) open();
      }}
    >
      <LaneAvatar lane={card.lane} />
      <div className="mate-body">
        <div className="who">
          <TitleLink card={card} onOpen={open} />
          <span className="age">{age(card.updatedAt, props.now)}</span>
        </div>
        <p className="line">
          {card.summary === "" ? "No messages yet" : <Rich text={card.summary} />}
        </p>
        <LiveChip card={card} now={props.now} />
        <OwedChip card={card} />
      </div>
    </article>
  );
}
