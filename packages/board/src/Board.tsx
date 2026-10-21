import { useState, type ReactNode } from "react";
import type { Board as BoardData, BoardCard } from "@fleet/protocol";
import {
  arrange,
  openIn,
  questionsByCard,
  swimlanes,
  type Columns,
  type Facts,
  type Swimlane,
} from "./format.ts";
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

function Cell(props: {
  readonly name: string;
  readonly label: string;
  readonly glyph: Glyph;
  readonly count: number;
  readonly children: ReactNode;
}) {
  return (
    <section
      className={`cell ${props.name}${props.count === 0 ? " none" : ""}`}
      aria-label={props.label}
    >
      <header className="cell-head">
        <StatusIcon glyph={props.glyph} />
        <h3>{props.label}</h3>
        <span className="n">{props.count}</span>
      </header>
      <div className="cell-body">{props.children}</div>
    </section>
  );
}

type Render = (card: BoardCard) => ReactNode;

function UpNext(props: { readonly columns: Columns; readonly render: Render }) {
  const { queued, later } = props.columns;
  return (
    <Cell name="up-next" label="Up next" glyph="queued" count={queued.length + later.length}>
      {queued.length > 0 && later.length > 0 ? <p className="sub">Queued</p> : null}
      {queued.map(props.render)}
      {later.length > 0 ? (
        <p className="sub">
          <ClockIcon />
          Later
        </p>
      ) : null}
      {later.map(props.render)}
    </Cell>
  );
}

function DoneToday(props: { readonly cards: readonly BoardCard[]; readonly render: Render }) {
  const [more, setMore] = useState(false);
  const { cards } = props;
  return (
    <Cell name="done" label="Done today" glyph="done" count={cards.length}>
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
    </Cell>
  );
}

function Lane(props: { readonly lane: Swimlane; readonly render: Render; readonly row: Render }) {
  const { lane, render, row } = props;
  const { columns } = lane;
  return (
    <section className="swimlane" aria-label={lane.project}>
      <header className="lane-head">
        <h2>{lane.project}</h2>
        <span className="n">{openIn(lane)} open</span>
        {lane.needs === 0 ? null : <span className="need-count">{lane.needs} for you</span>}
      </header>
      <div className="cells">
        <UpNext columns={columns} render={render} />
        <Cell name="progress" label="In progress" glyph="working" count={columns.progress.length}>
          {columns.progress.map(render)}
        </Cell>
        <Cell name="needs" label="Needs you" glyph="needs" count={columns.needs.length}>
          {columns.needs.map(render)}
        </Cell>
        <Cell name="merging" label="Merging" glyph="merging" count={columns.merging.length}>
          {columns.merging.map(render)}
        </Cell>
        <DoneToday cards={columns.today} render={row} />
      </div>
    </section>
  );
}

function Heads(props: { readonly columns: Columns }) {
  const { columns } = props;
  const heads: readonly { name: string; label: string; glyph: Glyph; count: number }[] = [
    {
      name: "up-next",
      label: "Up next",
      glyph: "queued",
      count: columns.queued.length + columns.later.length,
    },
    { name: "progress", label: "In progress", glyph: "working", count: columns.progress.length },
    { name: "needs", label: "Needs you", glyph: "needs", count: columns.needs.length },
    { name: "merging", label: "Merging", glyph: "merging", count: columns.merging.length },
    { name: "done", label: "Done today", glyph: "done", count: columns.today.length },
  ];
  return (
    <div className="col-heads" aria-hidden="true">
      {heads.map((head) => (
        <div key={head.name} className={`col-head ${head.name}`}>
          <StatusIcon glyph={head.glyph} />
          <span className="name">{head.label}</span>
          <span className="n">{head.count}</span>
        </div>
      ))}
    </div>
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
  const lanes = swimlanes(shown, asked, now);
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
    <div className={columns.merging.length === 0 ? "board-body no-merging" : "board-body"}>
      <div className="swimlanes">
        <Heads columns={columns} />
        {lanes.length === 0 ? <p className="empty">Nothing is on the board.</p> : null}
        {lanes.map((lane) => (
          <Lane key={lane.project} lane={lane} render={cardOf} row={row} />
        ))}
      </div>
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
