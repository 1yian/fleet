// A card's detail, laid out like an issue page: the title and description, the
// card's properties beside them, the questions that wait on the captain, the whole
// thread in time order, and a box to write to the card's mate.
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import type { BoardCard, Entry, Thread } from "@fleet/protocol";
import { loadThread, unreachable } from "./api.ts";
import { Ask } from "./Ask.tsx";
import {
  authorOf,
  bodyOf,
  firstLine,
  isActive,
  isMessage,
  keyOf,
  phraseOf,
  since,
  toneOf,
  verb,
  type Author,
  type Question,
} from "./format.ts";
import { BackIcon, SendIcon, StatusIcon } from "./icons.tsx";

interface Props {
  readonly card: BoardCard;
  readonly questions: readonly Question[];
  readonly now: number;
  readonly changes: number;
  readonly draft: string;
  readonly onDraft: (text: string) => void;
  readonly onClose: () => void;
  readonly onAnswer: (hold: number, choice: string, written: boolean) => Promise<boolean>;
  /** Resolves true when cardd took the message. */
  readonly onReply: (text: string) => Promise<boolean>;
  readonly onFail: (message: string) => void;
}

/** A one-line event longer than this opens to its whole text. */
const LONG_LINE = 90;

/** How far from the bottom of the page the captain may be and still follow new entries. */
const NEAR_BOTTOM = 240;

export function CardDetail(props: Props) {
  const { card, questions, now, changes, onFail } = props;
  const [thread, setThread] = useState<Thread | undefined>();
  useEffect(() => {
    let current = true;
    loadThread(card.id).then(
      (loaded) => {
        if (current) setThread(loaded);
      },
      (error: unknown) => {
        if (current) onFail(unreachable(error));
      },
    );
    return () => {
      current = false;
    };
  }, [card.id, changes, onFail]);

  useEffect(() => {
    const before = document.title;
    document.title = `c-${String(card.id)} ${card.title} · Fleet`;
    return () => {
      document.title = before;
    };
  }, [card.id, card.title]);

  // A new entry scrolls into view when the captain is at the end of the thread or wrote it.
  const end = useRef<HTMLDivElement>(null);
  const seen = useRef<number | undefined>(undefined);
  const last = thread?.entries.at(-1);
  useEffect(() => {
    if (last === undefined) return;
    const known = seen.current;
    seen.current = last.id;
    if (known === undefined || known === last.id) return;
    const near = document.documentElement.scrollHeight - window.scrollY - window.innerHeight;
    if (last.author === "captain" || near < NEAR_BOTTOM + 200)
      end.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [last]);

  const asked = questions.length > 0;
  const open = new Set(questions.map((question) => question.hold));
  return (
    <div className="detail">
      <nav className="crumbs" aria-label="Breadcrumb">
        <button type="button" className="back" onClick={props.onClose}>
          <BackIcon />
          Fleet
        </button>
        <span className="sep" aria-hidden="true">
          /
        </span>
        <span className="card-id">c-{card.id}</span>
        <kbd className="esc" title="Escape closes the card">
          Esc
        </kbd>
      </nav>
      <article className="detail-grid" aria-label={card.title}>
        <header className="detail-head">
          <h1>{card.title}</h1>
        </header>
        <Properties card={card} asked={asked} now={now} />
        <div className="detail-main">
          <Description card={card} />
          {asked ? (
            <section className="waiting" aria-label="Waiting for you">
              <h2>Waiting for you</h2>
              {questions.map((question, index) => (
                <Ask
                  key={question.hold}
                  question={question}
                  keys={index === 0}
                  onAnswer={props.onAnswer}
                />
              ))}
            </section>
          ) : null}
          <section className="activity" aria-label="Activity">
            <h2>Activity</h2>
            {thread === undefined ? (
              <p className="muted">Loading…</p>
            ) : (
              <Entries entries={thread.entries} open={open} now={now} />
            )}
          </section>
          <div ref={end} className="end" />
          <Composer
            lane={card.lane}
            mate={card.mate}
            draft={props.draft}
            onDraft={props.onDraft}
            onReply={props.onReply}
          />
        </div>
      </article>
    </div>
  );
}

/** A card that is not on the board: a bad address, or a card that was never made. */
export function NoCard({ id, onClose }: { readonly id: number; readonly onClose: () => void }) {
  return (
    <div className="detail">
      <nav className="crumbs" aria-label="Breadcrumb">
        <button type="button" className="back" onClick={onClose}>
          <BackIcon />
          Fleet
        </button>
      </nav>
      <p className="empty">c-{id} is not on the board.</p>
    </div>
  );
}

const prLabel = (url: string): string => {
  const match = /^https:\/\/[^/]+\/[^/]+\/([^/]+)\/pull\/(\d+)/.exec(url);
  return match === null ? url.replace(/^https:\/\//, "") : `${match[1] ?? ""}#${match[2] ?? ""}`;
};

function Properties(props: {
  readonly card: BoardCard;
  readonly asked: boolean;
  readonly now: number;
}) {
  const { card, asked, now } = props;
  const tone = toneOf(card, asked);
  const row = (label: string, value: ReactNode) => (
    <div className="property">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
  return (
    <dl className={`properties ${tone}`} aria-label="Properties">
      {row(
        "Status",
        <>
          <StatusIcon tone={tone} active={isActive(card)} />
          {phraseOf(card, asked)}
        </>,
      )}
      {row("Lane", <span className="tag">{card.lane}</span>)}
      {card.mate ? null : row("Project", card.project ?? <span className="muted">None</span>)}
      {row("Kind", <span className="kind">{card.mate ? "lane card" : card.kind}</span>)}
      {card.pr === null
        ? null
        : row(
            "Pull request",
            <a href={card.pr} target="_blank" rel="noreferrer">
              {prLabel(card.pr)}
            </a>,
          )}
      {card.mate ? null : row("Updated", since(card.updatedAt, now))}
      {row(
        "Created",
        <time dateTime={new Date(card.createdAt).toISOString()}>
          {new Date(card.createdAt).toLocaleDateString(undefined, {
            month: "short",
            day: "numeric",
            year: "numeric",
          })}
        </time>,
      )}
    </dl>
  );
}

function Description({ card }: { readonly card: BoardCard }) {
  const [spec, setSpec] = useState(false);
  if (card.intent.trim() === "" && card.spec.trim() === "") return null;
  return (
    <section className="description" aria-label="Description">
      {card.intent.trim() === "" ? null : <Collapsible text={card.intent} />}
      {card.spec.trim() === "" ? null : (
        <div className={`spec${spec ? " open" : ""}`}>
          <button
            type="button"
            className="spec-toggle"
            aria-expanded={spec}
            onClick={() => {
              setSpec(!spec);
            }}
          >
            <span className="caret" aria-hidden="true" />
            Spec
          </button>
          {spec ? <Collapsible text={card.spec} /> : null}
        </div>
      )}
    </section>
  );
}

/** Text that stops after a few lines, with a way to read the rest. */
function Collapsible({ text }: { readonly text: string }) {
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = box.current;
    if (element === null || expanded) return;
    const measure = (): void => {
      setOverflows(element.scrollHeight > element.clientHeight + 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [text, expanded]);
  return (
    <div className="collapsible">
      <div ref={box} className={expanded ? "body" : "body clamped"}>
        {text}
      </div>
      {overflows || expanded ? (
        <button
          type="button"
          className="more"
          aria-expanded={expanded}
          onClick={() => {
            setExpanded(!expanded);
          }}
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      ) : null}
    </div>
  );
}

function Entries(props: {
  readonly entries: readonly Entry[];
  readonly open: ReadonlySet<number>;
  readonly now: number;
}) {
  if (props.entries.length === 0) return <p className="muted">No activity yet.</p>;
  return (
    <ol className="thread" aria-label="Thread">
      {props.entries.map((entry) =>
        isMessage(entry) && !props.open.has(entry.id) ? (
          <Message key={entry.id} entry={entry} now={props.now} />
        ) : (
          <Event key={entry.id} entry={entry} now={props.now} waiting={props.open.has(entry.id)} />
        ),
      )}
    </ol>
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

/** Something said: a comment, a question, an answer, or a worker's report. */
function Message({ entry, now }: { readonly entry: Entry; readonly now: number }) {
  const author = authorOf(entry.author);
  return (
    <li className={`message ${author.role}`} data-kind={entry.kind}>
      <header>
        <Avatar author={author} />
        <span className="name">{author.name}</span>
        {author.tag === "" ? null : <span className="tag">{author.tag}</span>}
        <span className="verb">{verb(entry)}</span>
        {keyOf(entry) === undefined ? null : <span className="key">{keyOf(entry)}</span>}
        <Time entry={entry} now={now} />
      </header>
      <Collapsible text={bodyOf(entry)} />
    </li>
  );
}

/** Something that happened, or a task message: one line, and the whole text on a click. */
function Event(props: {
  readonly entry: Entry;
  readonly now: number;
  /** The question is still open, and is answered above. */
  readonly waiting: boolean;
}) {
  const { entry, now, waiting } = props;
  const [open, setOpen] = useState(false);
  const author = authorOf(entry.author);
  const body = waiting ? "" : bodyOf(entry).trim();
  const line = firstLine(body);
  const expands = body !== line || line.length > LONG_LINE;
  const head = (
    <>
      <span className="dot" aria-hidden="true" />
      <span className="name">{author.name}</span>
      <span className="verb">{waiting ? "asked a question" : verb(entry)}</span>
      {open ? (
        <span className="line" />
      ) : (
        <span className="line">{waiting ? "waiting for your answer above" : line}</span>
      )}
      <Time entry={entry} now={now} />
    </>
  );
  return (
    <li className={`event${open ? " open" : ""}`} data-kind={entry.kind}>
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
    </li>
  );
}

/** The captain's message to the card's mate. Enter sends and Shift+Enter starts a new line. */
function Composer(props: {
  readonly lane: string;
  /** A lane card: the captain talks to the second mate itself. */
  readonly mate: boolean;
  readonly draft: string;
  readonly onDraft: (text: string) => void;
  readonly onReply: (text: string) => Promise<boolean>;
}) {
  const { lane, mate, draft, onDraft } = props;
  const [sending, setSending] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const empty = draft.trim() === "";
  // The box grows with its text, up to a few lines.
  useLayoutEffect(() => {
    const element = box.current;
    if (element === null) return;
    element.style.height = "auto";
    element.style.height = `${String(element.scrollHeight)}px`;
  }, [draft]);
  const send = async (): Promise<void> => {
    if (empty || sending) return;
    setSending(true);
    const taken = await props.onReply(draft.trim());
    setSending(false);
    if (taken) onDraft("");
  };
  const key = (event: KeyboardEvent): void => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  };
  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <div className="composer-box">
        <textarea
          ref={box}
          aria-label="Comment"
          rows={1}
          value={draft}
          placeholder={mate ? `Message ${lane}` : `Message ${lane} about this card`}
          onChange={(event) => {
            onDraft(event.target.value);
          }}
          onKeyDown={key}
        />
        <button type="submit" className="send-round" aria-label="Send" disabled={sending || empty}>
          <SendIcon />
        </button>
      </div>
      <p className="hint">Goes to {lane}. Enter to send, Shift+Enter for a new line.</p>
    </form>
  );
}
