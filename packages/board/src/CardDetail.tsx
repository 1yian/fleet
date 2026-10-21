import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import type { BoardCard, Thread } from "@fleet/protocol";
import { loadThread, unreachable } from "./api.ts";
import { Ask } from "./Ask.tsx";
import { Stale } from "./Stale.tsx";
import { idLabel } from "./text.ts";
import { Collapsible } from "./Collapsible.tsx";
import { Entries } from "./Thread.tsx";
import { LiveChip } from "./TaskCard.tsx";
import { glyphOf, phraseOf, prLabel, since, type Question } from "./format.ts";
import { BackIcon, SendIcon, StatusIcon } from "./icons.tsx";

interface Props {
  readonly card: BoardCard;
  readonly question: Question | undefined;
  readonly now: number;
  readonly changes: number;
  readonly draft: string;
  readonly onDraft: (text: string) => void;
  readonly onClose: () => void;
  readonly onAnswer: (hold: number, choice: string, written: boolean) => Promise<boolean>;
  readonly onLater: (until: number, reason: string) => void;
  readonly notice: string | undefined;
  readonly onDismiss: () => void;
  readonly onReply: (text: string) => Promise<boolean>;
  readonly onFail: (message: string) => void;
}

const NEAR_BOTTOM = 240;

export function CardDetail(props: Props) {
  const { card, question, now, changes, onFail } = props;
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
    document.title = `${idLabel(card.id)} ${card.title} · Fleet`;
    return () => {
      document.title = before;
    };
  }, [card.id, card.title]);

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

  const asked = question !== undefined;
  const open = new Set(question === undefined ? [] : [question.hold]);
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
        <span className="card-id">{idLabel(card.id)}</span>
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
          {props.notice === undefined ? null : (
            <Stale text={props.notice} onDismiss={props.onDismiss} />
          )}
          {question === undefined ? null : (
            <Waiting question={question} onAnswer={props.onAnswer} onLater={props.onLater} />
          )}
          <section className="activity" aria-label="Activity">
            <header className="activity-head">
              <h2>Activity</h2>
              <LiveChip card={card} now={now} always />
            </header>
            {thread === undefined ? (
              <p className="muted">Loading…</p>
            ) : (
              <Entries
                entries={thread.entries}
                lane={card.lane}
                open={open}
                now={now}
                owed={card.replies}
              />
            )}
          </section>
          <div ref={end} className="end" />
          <Composer draft={props.draft} onDraft={props.onDraft} onReply={props.onReply} />
        </div>
      </article>
    </div>
  );
}

function Waiting(props: {
  readonly question: Question;
  readonly onAnswer: Props["onAnswer"];
  readonly onLater: Props["onLater"];
}) {
  return (
    <section className="waiting" aria-label="Waiting for you">
      <h2>Waiting for you</h2>
      <Ask
        question={props.question}
        showQuestion
        onRead={undefined}
        onAnswer={props.onAnswer}
        onLater={props.onLater}
      />
    </section>
  );
}

export function NoCard({ id, onClose }: { readonly id: number; readonly onClose: () => void }) {
  return (
    <div className="detail">
      <nav className="crumbs" aria-label="Breadcrumb">
        <button type="button" className="back" onClick={onClose}>
          <BackIcon />
          Fleet
        </button>
      </nav>
      <p className="empty">{idLabel(id)} is not on the board.</p>
    </div>
  );
}

function Properties(props: {
  readonly card: BoardCard;
  readonly asked: boolean;
  readonly now: number;
}) {
  const { card, asked, now } = props;
  const row = (label: string, value: ReactNode) => (
    <div className="property">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
  return (
    <dl className="properties" aria-label="Properties">
      {row(
        "Status",
        <>
          <StatusIcon glyph={glyphOf(card, asked)} />
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
      {card.replies.length === 0 ? null : (
        <div className="property replies">
          <dt>Replies</dt>
          <dd>
            <ul className="owed-replies">
              {card.replies.map((each) => (
                <li key={each.id} title={each.text}>
                  <span>
                    {each.owes} owes {each.from}
                  </span>
                  <span className="muted">
                    {each.id} ·{" "}
                    {each.escalatedAt === null
                      ? `asked ${since(each.askedAt, now)}`
                      : `escalated ${since(each.escalatedAt, now)}`}
                  </span>
                </li>
              ))}
            </ul>
          </dd>
        </div>
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

function Composer(props: {
  readonly draft: string;
  readonly onDraft: (text: string) => void;
  readonly onReply: (text: string) => Promise<boolean>;
}) {
  const { draft, onDraft } = props;
  const [sending, setSending] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const empty = draft.trim() === "";
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
          placeholder="Message main about this card"
          onChange={(event) => {
            onDraft(event.target.value);
          }}
          onKeyDown={key}
        />
        <button type="submit" className="send-round" aria-label="Send" disabled={sending || empty}>
          <SendIcon />
        </button>
      </div>
      <p className="hint">
        Goes to main only, who passes it on if needed. Enter to send, Shift+Enter for a new line.
      </p>
    </form>
  );
}
