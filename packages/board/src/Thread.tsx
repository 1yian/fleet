import { useState, type ReactNode } from "react";
import type { Entry, OwedReply } from "@fleet/protocol";
import { Collapsible } from "./Collapsible.tsx";
import { Rich } from "./Rich.tsx";
import { authorOf, firstLine, isMessage, keyOf, since, verb, type Author } from "./format.ts";
import { threadRows, type Flow, type Row } from "./thread.ts";

const LONG_LINE = 90;

type Open = ReadonlySet<number>;

function ThreadRow(props: {
  readonly row: Row;
  readonly open: Open;
  readonly now: number;
  readonly children?: ReactNode;
}) {
  const { row, open, now, children } = props;
  const waiting = open.has(row.entry.id);
  const failure = attention(row.entry);
  return (isMessage(row.entry) && !row.quiet && !waiting) || failure ? (
    <Message row={row} now={now}>
      {children}
    </Message>
  ) : (
    <Event row={row} now={now} waiting={waiting}>
      {children}
    </Event>
  );
}

function attention(entry: Entry): boolean {
  return (
    entry.fields["state"] === "failed" ||
    entry.kind === "finding" ||
    (entry.kind === "report" &&
      ["blocked", "failed", "stopped", "needs-decision"].includes(String(entry.fields["status"])))
  );
}

function Replies(props: {
  readonly rows: readonly Row[];
  readonly open: Open;
  readonly now: number;
  readonly waiting: boolean;
  readonly owes: string | undefined;
}) {
  if (props.rows.length === 0 && !props.waiting) return null;
  return (
    <ol className="replies" aria-label="Replies">
      {props.rows.map((row) => (
        <ThreadRow key={row.entry.id} row={row} open={props.open} now={props.now} />
      ))}
      {props.rows.length === 0 && props.waiting ? (
        <li className="reply-owed">{props.owes ?? "Recipient"} owes a reply</li>
      ) : null}
    </ol>
  );
}

export function Entries(props: {
  readonly entries: readonly Entry[];
  readonly lane: string;
  readonly open: Open;
  readonly now: number;
  readonly owed: readonly OwedReply[];
}) {
  const [history, setHistory] = useState(false);
  if (props.entries.length === 0) return <p className="muted">No activity yet.</p>;
  const all = threadRows(props.entries, { lane: props.lane });
  const latest = all.findLast(
    (row) => row.replyTo === undefined && ["report", "cleanup"].includes(row.entry.kind),
  );
  const hidden = new Set(all.filter((row) => technical(row, latest)).map((row) => row.entry.id));
  const rows = history ? all : all.filter((row) => row !== latest && !hidden.has(row.entry.id));
  const replies = new Map<number, Row[]>();
  for (const row of rows) {
    if (row.replyTo?.author === "captain") {
      const id = row.replyTo.id;
      replies.set(id, [...(replies.get(id) ?? []), row]);
    }
  }
  const nested = new Set([...replies.values()].flat().map((row) => row.entry.id));
  return (
    <>
      <Latest row={latest} history={history} />
      {hidden.size === 0 ? null : (
        <button
          type="button"
          className="history-toggle"
          aria-expanded={history}
          onClick={() => {
            setHistory(!history);
          }}
        >
          {history ? "Hide technical history" : `Show technical history (${String(hidden.size)})`}
        </button>
      )}
      <ol className="thread" aria-label="Thread">
        {rows
          .filter((row) => !nested.has(row.entry.id))
          .map((row) => (
            <ThreadRow key={row.entry.id} row={row} open={props.open} now={props.now}>
              <Replies
                rows={replies.get(row.entry.id) ?? []}
                open={props.open}
                now={props.now}
                waiting={props.owed.some((each) => each.id === `r-${String(row.entry.id)}`)}
                owes={props.owed.find((each) => each.id === `r-${String(row.entry.id)}`)?.owes}
              />
            </ThreadRow>
          ))}
      </ol>
    </>
  );
}

function Latest({ row, history }: { readonly row: Row | undefined; readonly history: boolean }) {
  if (row === undefined) return null;
  const { entry } = row;
  return (
    <section
      id={history ? undefined : `entry-${String(entry.id)}`}
      className="latest-update"
      aria-label="Latest update"
    >
      <h3>Latest update</h3>
      <p className="update-source">
        {authorOf(entry.author).name} · {verb(entry)} ·{" "}
        <time dateTime={new Date(entry.createdAt).toISOString()}>
          {new Date(entry.createdAt).toLocaleString()}
        </time>{" "}
        <Key entry={entry} />
      </p>
      <Collapsible text={row.original} />
    </section>
  );
}

function technical(row: Row, latest: Row | undefined): boolean {
  const { entry } = row;
  if (entry.author === "captain" || row.replyTo !== undefined) return false;
  if (typeof entry.fields["resolves"] === "string") return false;
  if (entry.fields["maintenance"] !== undefined)
    return entry.fields["state"] === "completed" && entry.fields["quiet"] === true;
  if (entry.kind === "report")
    return (
      row !== latest && (entry.fields["status"] === "working" || entry.fields["status"] === "note")
    );
  if (entry.kind !== "comment") return false;
  return taskRouting(row);
}

function taskRouting({ entry, flow }: Row): boolean {
  return entry.fields["task"] === true || entry.fields["routed"] === true || flow?.to === "worker";
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

function Direction(props: { readonly flow: Flow | undefined; readonly name: string }) {
  const { flow } = props;
  if (flow === undefined) return <span className="name">{props.name}</span>;
  return (
    <span className="flow">
      <span className="name from">{flow.from}</span>{" "}
      <span className="arrow" aria-hidden="true">
        →
      </span>{" "}
      <span className="to">{flow.to}</span>
    </span>
  );
}

function Key({ entry }: { readonly entry: Entry }) {
  const key = keyOf(entry);
  return key === undefined ? null : <span className="key">{key}</span>;
}

function InReply({ entry }: { readonly entry: Entry }) {
  const who = authorOf(entry.author).name;
  const show = (): void => {
    const target = document.getElementById(`entry-${String(entry.id)}`);
    target?.scrollIntoView({ block: "center", behavior: "smooth" });
    target?.classList.add("flash");
    target?.addEventListener(
      "animationend",
      () => {
        target.classList.remove("flash");
      },
      { once: true },
    );
  };
  return (
    <button type="button" className="reply-link" onClick={show}>
      <span className="label">
        <span aria-hidden="true">↳</span> In reply to {who === "You" ? "your message" : who}
      </span>
      {entry.author === "captain" ? <span className="quoted">{firstLine(entry.body)}</span> : null}
    </button>
  );
}

function Message(props: { readonly row: Row; readonly now: number; readonly children: ReactNode }) {
  const { row, now, children } = props;
  const { entry, flow } = row;
  const author = authorOf(entry.author);
  return (
    <li
      id={`entry-${String(entry.id)}`}
      className={`message ${author.role}`}
      data-kind={entry.kind}
      data-reply-to={row.replyTo?.id}
    >
      <header>
        <Avatar author={author} />
        <Direction flow={flow} name={author.name} />
        {flow !== undefined || author.tag === "" ? null : <span className="tag">{author.tag}</span>}
        <span className="verb">{verb(entry)}</span>
        <Key entry={entry} />
        <Time entry={entry} now={now} />
      </header>
      {row.replyTo === undefined ? null : <InReply entry={row.replyTo} />}
      <Collapsible text={row.text} />
      {children}
    </li>
  );
}

function waitingText(row: Row): string {
  if (row.asker === undefined) return "waiting for your answer above";
  return `escalated by ${authorOf(row.entry.author).name} · waiting for your answer above`;
}

function withAsker(row: Row): Flow | undefined {
  if (row.asker === undefined || row.flow === undefined) return row.flow;
  return { ...row.flow, from: row.asker };
}

function Line(props: { readonly row: Row; readonly waiting: boolean; readonly links: boolean }) {
  const { row } = props;
  return (
    <span className="line">
      {props.waiting ? waitingText(row) : <Rich text={firstLine(row.text)} links={props.links} />}
    </span>
  );
}

function Head(props: {
  readonly expands: boolean;
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly children: ReactNode;
}) {
  if (!props.expands) return <div className="event-head">{props.children}</div>;
  return (
    <button
      type="button"
      className="event-head"
      aria-expanded={props.open}
      onClick={props.onToggle}
    >
      {props.children}
    </button>
  );
}

const eventClass = (row: Row, open: boolean): string =>
  `event${open ? " open" : ""}${row.quiet ? " quiet" : ""}`;

function Event(props: {
  readonly row: Row;
  readonly now: number;
  readonly waiting: boolean;
  readonly children: ReactNode;
}) {
  const { row, now, waiting } = props;
  const { entry } = row;
  const [open, setOpen] = useState(false);
  const body = waiting ? "" : row.original.trim();
  const summary = firstLine(row.text);
  const expands = !waiting && (body !== summary || summary.length > LONG_LINE);
  const reply = row.replyTo === undefined ? null : <InReply entry={row.replyTo} />;
  const flow = waiting ? withAsker(row) : row.flow;
  const head = (
    <>
      <span className="dot" aria-hidden="true" />
      <Direction flow={flow} name={authorOf(entry.author).name} />
      <span className="verb">{waiting ? "asked a question" : verb(entry)}</span>
      <Key entry={entry} />
      {open ? <span className="line" /> : <Line row={row} waiting={waiting} links={!expands} />}
      <Time entry={entry} now={now} />
    </>
  );
  return (
    <li
      id={`entry-${String(entry.id)}`}
      className={eventClass(row, open)}
      data-kind={entry.kind}
      data-reply-to={row.replyTo?.id}
    >
      <Head
        expands={expands}
        open={open}
        onToggle={() => {
          setOpen(!open);
        }}
      >
        {head}
      </Head>
      {reply}
      {open ? (
        <p className="event-more">
          <Rich text={body} />
        </p>
      ) : null}
      {props.children}
    </li>
  );
}
