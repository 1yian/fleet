import { useState } from "react";
import type { ReactNode } from "react";
import type { Entry, OwedReply } from "@fleet/protocol";
import { Collapsible } from "./Collapsible.tsx";
import {
  authorOf,
  bodyOf,
  firstLine,
  isMessage,
  keyOf,
  since,
  verb,
  type Author,
} from "./format.ts";

const LONG_LINE = 90;

const REPLY_ID = /^r-(\d+)$/;

function answeredIn(entry: Entry, asked: ReadonlyMap<number, Entry>): number | undefined {
  const to = entry.fields["replyTo"];
  const id = typeof to === "string" ? Number(REPLY_ID.exec(to)?.[1]) : Number.NaN;
  return asked.has(id) ? id : undefined;
}

function Row(props: {
  readonly entry: Entry;
  readonly open: ReadonlySet<number>;
  readonly now: number;
  readonly to?: Entry;
  readonly children?: ReactNode;
}) {
  const { entry, open, now, to, children } = props;
  const waiting = open.has(entry.id);
  if (isMessage(entry) && !waiting)
    return (
      <Message entry={entry} now={now} to={to}>
        {children}
      </Message>
    );
  return (
    <Event entry={entry} now={now} waiting={waiting} to={to}>
      {children}
    </Event>
  );
}

export function Entries(props: {
  readonly entries: readonly Entry[];
  readonly open: ReadonlySet<number>;
  readonly now: number;
  readonly owed: readonly OwedReply[];
}) {
  const { entries, open, now, owed } = props;
  if (entries.length === 0) return <p className="muted">No activity yet.</p>;
  const asked = new Map(
    entries
      .filter((entry) => entry.author === "captain" && entry.kind === "comment")
      .map((entry) => [entry.id, entry]),
  );
  const replies = new Map<number, Entry[]>();
  for (const entry of entries) {
    const to = answeredIn(entry, asked);
    if (to !== undefined) replies.set(to, [...(replies.get(to) ?? []), entry]);
  }
  const nested = new Set([...replies.values()].flat().map((entry) => entry.id));
  return (
    <ol className="thread" aria-label="Thread">
      {entries
        .filter((entry) => !nested.has(entry.id))
        .map((entry) => {
          const answers = replies.get(entry.id) ?? [];
          const waiting = owed.some((each) => each.id === `r-${String(entry.id)}`);
          return (
            <Row key={entry.id} entry={entry} open={open} now={now}>
              {answers.length === 0 && !waiting ? null : (
                <ol className="replies" aria-label="Replies">
                  {answers.map((answer) => (
                    <Row key={answer.id} entry={answer} open={open} now={now} to={entry} />
                  ))}
                  {waiting && answers.length === 0 ? (
                    <li className="reply-owed">Waiting for a reply</li>
                  ) : null}
                </ol>
              )}
            </Row>
          );
        })}
    </ol>
  );
}

function ReplyLink({ to }: { readonly to: Entry }) {
  const author = authorOf(to.author);
  const show = (): void => {
    const target = document.getElementById(`entry-${String(to.id)}`);
    target?.scrollIntoView({ block: "center", behavior: "smooth" });
    target?.classList.add("flash");
    window.setTimeout(() => target?.classList.remove("flash"), 1200);
  };
  return (
    <button type="button" className="reply-link" onClick={show}>
      <span aria-hidden="true">↳</span> In reply to{" "}
      {author.name === "You" ? "your message" : author.name}
      <span className="quoted">{firstLine(bodyOf(to))}</span>
    </button>
  );
}

function Avatar({ author }: { readonly author: Author }) {
  return (
    <span className={`avatar ${author.role}`} aria-hidden="true">
      {author.name.charAt(0).toUpperCase()}
    </span>
  );
}

function Time({ entry, now }: { readonly entry: Entry; readonly now: number }) {
  const at = new Date(entry.createdAt);
  return (
    <time dateTime={at.toISOString()} title={at.toLocaleString()}>
      {since(entry.createdAt, now)}
    </time>
  );
}

function Message(props: {
  readonly entry: Entry;
  readonly now: number;
  readonly to: Entry | undefined;
  readonly children: ReactNode;
}) {
  const { entry, now, to, children } = props;
  const author = authorOf(entry.author);
  return (
    <li
      id={`entry-${String(entry.id)}`}
      className={`message ${author.role}`}
      data-kind={entry.kind}
      data-reply-to={to?.id}
    >
      {to === undefined ? null : <ReplyLink to={to} />}
      <header>
        <Avatar author={author} />
        <span className="name">{author.name}</span>
        {author.tag === "" ? null : <span className="tag">{author.tag}</span>}
        <span className="verb">{verb(entry)}</span>
        {keyOf(entry) === undefined ? null : <span className="key">{keyOf(entry)}</span>}
        <Time entry={entry} now={now} />
      </header>
      <Collapsible text={bodyOf(entry)} />
      {children}
    </li>
  );
}

function EventHead(props: {
  readonly entry: Entry;
  readonly now: number;
  readonly waiting: boolean;
  readonly open: boolean;
  readonly line: string;
}) {
  const { entry, now, waiting, open, line } = props;
  const author = authorOf(entry.author);
  const shown = waiting ? "waiting for your answer above" : line;
  return (
    <>
      <span className="dot" aria-hidden="true" />
      <span className="name">{author.name}</span>
      <span className="verb">{waiting ? "asked a question" : verb(entry)}</span>
      <span className="line">{open ? "" : shown}</span>
      <Time entry={entry} now={now} />
    </>
  );
}

function Event(props: {
  readonly entry: Entry;
  readonly now: number;
  readonly waiting: boolean;
  readonly to: Entry | undefined;
  readonly children: ReactNode;
}) {
  const { entry, now, waiting, to, children } = props;
  const [open, setOpen] = useState(false);
  const body = waiting ? "" : bodyOf(entry).trim();
  const line = firstLine(body);
  const expands = body !== line || line.length > LONG_LINE;
  const head = <EventHead entry={entry} now={now} waiting={waiting} open={open} line={line} />;
  return (
    <li
      id={`entry-${String(entry.id)}`}
      className={`event${open ? " open" : ""}`}
      data-kind={entry.kind}
      data-reply-to={to?.id}
    >
      {to === undefined ? null : <ReplyLink to={to} />}
      {expands ? (
        <button
          type="button"
          className="event-head"
          aria-expanded={open}
          onClick={() => {
            setOpen(!open);
          }}
        >
          {head}
        </button>
      ) : (
        <div className="event-head">{head}</div>
      )}
      {open ? <p className="event-more">{body}</p> : null}
      {children}
    </li>
  );
}
