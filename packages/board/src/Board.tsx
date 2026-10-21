import { useState, type ReactNode } from "react";
import type { Board as BoardData, BoardCard } from "@fleet/protocol";
import { arrange, questionsByCard, type Columns, type Facts } from "./format.ts";
import { ChevronIcon, ClockIcon, StatusIcon, type Glyph } from "./icons.tsx";
import { DoneRow, MateRow, TaskCard } from "./TaskCard.tsx";

const TODAY_SHOWN = 8;
const RAIL_SHOWN = 25;

interface Props {
  readonly board: BoardData;
  readonly lane: string | undefined;
  readonly now: number;
  readonly facts: ReadonlyMap<number, Facts>;
  readonly onOpen: (card: number) => void;
  readonly onAnswer: (
    card: number,
    hold: number,
    choice: string,
    written: boolean,
  ) => Promise<boolean>;
  readonly onLater: (card: number, until: number, reason: string) => void;
  readonly onDismiss: (card: number) => void;
  readonly notices: ReadonlyMap<number, string>;
}

function Column(props: {
  readonly name: string;
  readonly label: string;
  readonly glyph: Glyph;
  readonly count: number;
  readonly children: ReactNode;
}) {
  return (
    <section className={`col ${props.name}`} aria-label={props.label}>
      <header className="col-head">
        <StatusIcon glyph={props.glyph} />
        <h2>{props.label}</h2>
        <span className="n">{props.count}</span>
      </header>
      <div className="col-body">{props.children}</div>
    </section>
  );
}

const empty = (text: string) => <p className="empty">{text}</p>;

type Render = (card: BoardCard) => ReactNode;

function UpNext(props: { readonly columns: Columns; readonly render: Render }) {
  const { queued, later } = props.columns;
  const count = queued.length + later.length;
  return (
    <Column name="up-next" label="Up next" glyph="queued" count={count}>
      {count === 0 ? empty("Nothing is queued.") : null}
      {queued.length > 0 && later.length > 0 ? <p className="sub">Queued</p> : null}
      {queued.map(props.render)}
      {later.length > 0 ? (
        <p className="sub">
          <ClockIcon />
          Later
        </p>
      ) : null}
      {later.map(props.render)}
    </Column>
  );
}

function DoneToday(props: { readonly cards: readonly BoardCard[]; readonly render: Render }) {
  const [more, setMore] = useState(false);
  const { cards } = props;
  return (
    <Column name="done" label="Done today" glyph="done" count={cards.length}>
      {cards.length === 0 ? empty("Nothing has finished today.") : null}
      {(more ? cards : cards.slice(0, TODAY_SHOWN)).map(props.render)}
      {cards.length > TODAY_SHOWN ? (
        <button
          type="button"
          className="show-more"
          aria-expanded={more}
          onClick={() => {
            setMore(!more);
          }}
        >
          {more ? "Show fewer" : `${String(cards.length - TODAY_SHOWN)} more today`}
        </button>
      ) : null}
    </Column>
  );
}

function Rail(props: {
  readonly columns: Columns;
  readonly now: number;
  readonly row: Render;
  readonly onOpen: Props["onOpen"];
}) {
  const { columns } = props;
  return (
    <aside className="rail" aria-label="Rail">
      <section className="rail-section" aria-label="Hidden columns">
        <h4>Hidden columns</h4>
        {columns.merging.length === 0 ? (
          <div className="hidden-col idle">
            <StatusIcon glyph="merging" />
            <span>Merging</span>
            <span className="n">0</span>
          </div>
        ) : null}
        <Hidden label="Dropped" glyph="dropped" cards={columns.dropped} row={props.row} />
        <Hidden label="Older done" glyph="done" cards={columns.older} row={props.row} />
      </section>
      {columns.mates.length === 0 ? null : (
        <section className="rail-section" aria-label="Mates">
          <h4>Mates</h4>
          {columns.mates.map((card) => (
            <MateRow key={card.id} card={card} now={props.now} onOpen={props.onOpen} />
          ))}
        </section>
      )}
    </aside>
  );
}

export function Kanban(props: Props) {
  const { board, now, facts } = props;
  const asked = questionsByCard(board.holds);
  const shown = board.cards.filter(
    (card) => card.mate || props.lane === undefined || card.lane === props.lane,
  );
  const columns = arrange(shown, asked, now);
  const cardOf: Render = (card) => (
    <TaskCard
      key={card.id}
      card={card}
      question={asked.get(card.id)}
      facts={facts.get(card.id)}
      notice={props.notices.get(card.id)}
      now={now}
      onOpen={props.onOpen}
      onAnswer={props.onAnswer}
      onLater={props.onLater}
      onDismiss={props.onDismiss}
    />
  );
  const row: Render = (card) => (
    <DoneRow key={card.id} card={card} facts={facts.get(card.id)} now={now} onOpen={props.onOpen} />
  );
  return (
    <div className={columns.merging.length === 0 ? "columns no-merging" : "columns"}>
      <UpNext columns={columns} render={cardOf} />
      <Column name="progress" label="In progress" glyph="working" count={columns.progress.length}>
        {columns.progress.length === 0 ? empty("Nothing is running.") : null}
        {columns.progress.map(cardOf)}
      </Column>
      <Column name="needs" label="Needs you" glyph="needs" count={columns.needs.length}>
        {columns.needs.length === 0 ? empty("Nothing waits on you.") : null}
        {columns.needs.map(cardOf)}
      </Column>
      {columns.merging.length === 0 ? null : (
        <Column name="merging" label="Merging" glyph="merging" count={columns.merging.length}>
          {columns.merging.map(cardOf)}
        </Column>
      )}
      <DoneToday cards={columns.today} render={row} />
      <Rail columns={columns} now={now} row={row} onOpen={props.onOpen} />
    </div>
  );
}

function Hidden(props: {
  readonly label: string;
  readonly glyph: Glyph;
  readonly cards: readonly BoardCard[];
  readonly row: Render;
}) {
  const [open, setOpen] = useState(false);
  const { cards } = props;
  return (
    <div className="hidden">
      <button
        type="button"
        className="hidden-col"
        aria-expanded={open}
        disabled={cards.length === 0}
        onClick={() => {
          setOpen(!open);
        }}
      >
        <StatusIcon glyph={props.glyph} />
        <span>{props.label}</span>
        <span className="n">{cards.length}</span>
        <ChevronIcon />
      </button>
      {open ? (
        <section className="hidden-rows" aria-label={props.label}>
          {cards.slice(0, RAIL_SHOWN).map(props.row)}
          {cards.length > RAIL_SHOWN ? (
            <p className="more-note">
              Latest {RAIL_SHOWN} of {cards.length}
            </p>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
