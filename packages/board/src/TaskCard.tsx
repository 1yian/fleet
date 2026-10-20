// One card in the inbox: its title, its latest news, and its status. A question
// for the captain shows with its answers, so one click answers it. The rest of
// the card's story opens in place: one line per update, and a reply box.
import { useEffect, useState, type SyntheticEvent } from "react";
import type { BoardCard, Entry, Thread } from "@fleet/protocol";
import { loadThread, unreachable } from "./api.ts";
import {
  bodyOf,
  firstLine,
  isActive,
  rest,
  since,
  statusLine,
  toneOf,
  verb,
  who,
  type Question,
} from "./format.ts";
import { Sparkle, StatusIcon } from "./icons.tsx";

interface Props {
  readonly card: BoardCard;
  readonly questions: readonly Question[];
  /** Whether number keys answer this card's first question. */
  readonly keys: boolean;
  readonly open: boolean;
  readonly now: number;
  readonly changes: number;
  readonly onToggle: () => void;
  readonly onAnswer: (ask: number, choice: string) => void;
  readonly onReply: (text: string) => Promise<void>;
  readonly onFail: (message: string) => void;
}

export function TaskCard(props: Props) {
  const { card, questions, keys, open, now } = props;
  const asked = questions.length > 0;
  const tone = toneOf(card, asked);
  return (
    <article className={`task ${tone}${open ? " open" : ""}`} aria-label={card.title}>
      <button type="button" className="task-head" aria-expanded={open} onClick={props.onToggle}>
        <Sparkle />
        <span className="task-title">{card.title}</span>
        {card.summary === "" ? null : <span className="task-summary">{card.summary}</span>}
      </button>
      <p className="task-status">
        <StatusIcon tone={tone} active={isActive(card)} />
        <span className="task-phrase">{statusLine(card, asked, now)}</span>
        <span className="tag">{card.lane}</span>
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
      {open ? (
        <Details
          card={card}
          now={now}
          changes={props.changes}
          onReply={props.onReply}
          onFail={props.onFail}
        />
      ) : null}
    </article>
  );
}

const LONG_OPTION = 32;

function Ask(props: {
  readonly question: Question;
  readonly keys: boolean;
  readonly onAnswer: (ask: number, choice: string) => void;
}) {
  const { question, keys, onAnswer } = props;
  // Options longer than a few words read better as a list of choices than as buttons in a row.
  const long = question.options.some((option) => option.length > LONG_OPTION);
  return (
    <div className="ask">
      <p className="ask-text">{question.question}</p>
      <div className={long ? "options long" : "options"}>
        {question.options.map((option, index) => (
          <button
            type="button"
            key={option}
            className={index === 0 ? "primary" : ""}
            onClick={() => {
              onAnswer(question.ask, option);
            }}
          >
            {keys && index < 9 ? <kbd>{index + 1}</kbd> : null}
            {option}
          </button>
        ))}
      </div>
    </div>
  );
}

function Details(props: {
  readonly card: BoardCard;
  readonly now: number;
  readonly changes: number;
  readonly onReply: (text: string) => Promise<void>;
  readonly onFail: (message: string) => void;
}) {
  const { card, now, changes, onFail } = props;
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
  return (
    <div className="details">
      {thread === undefined ? (
        <p className="muted">Loading…</p>
      ) : (
        <Updates entries={thread.entries} now={now} />
      )}
      <Reply lane={card.lane} onReply={props.onReply} />
    </div>
  );
}

function Updates({ entries, now }: { readonly entries: readonly Entry[]; readonly now: number }) {
  if (entries.length === 0) return <p className="muted">No updates yet.</p>;
  return (
    <ol className="updates" aria-label="Updates">
      {entries.map((entry) => (
        <Update key={entry.id} entry={entry} now={now} />
      ))}
    </ol>
  );
}

/** One update in one line. An update with more to say opens to the rest. */
function Update({ entry, now }: { readonly entry: Entry; readonly now: number }) {
  const [open, setOpen] = useState(false);
  const body = bodyOf(entry);
  const more = rest(body);
  const line = (
    <>
      <span className="who">
        {who(entry.author)} {verb(entry)}
      </span>
      <span className="line">{firstLine(body)}</span>
      <time dateTime={new Date(entry.createdAt).toISOString()}>{since(entry.createdAt, now)}</time>
    </>
  );
  return (
    <li className={`update${open ? " open" : ""}`}>
      {more === "" ? (
        <div className="update-head">{line}</div>
      ) : (
        <button
          type="button"
          className="update-head"
          aria-expanded={open}
          onClick={() => {
            setOpen(!open);
          }}
        >
          {line}
        </button>
      )}
      {open ? <p className="update-detail">{more}</p> : null}
    </li>
  );
}

/** The captain's message about the card, to its mate. A refused message stays in the box. */
function Reply({
  lane,
  onReply,
}: {
  readonly lane: string;
  readonly onReply: (text: string) => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const submit = async (event: SyntheticEvent): Promise<void> => {
    event.preventDefault();
    const words = text.trim();
    if (words === "" || sending) return;
    setSending(true);
    try {
      await onReply(words);
      setText("");
    } catch {
      // The notice says why. The words stay in the box to send again.
    } finally {
      setSending(false);
    }
  };
  return (
    <form
      className="reply"
      onSubmit={(event) => {
        void submit(event);
      }}
    >
      <input
        aria-label="Reply"
        value={text}
        placeholder={`Message ${lane} about this card`}
        onChange={(event) => {
          setText(event.target.value);
        }}
      />
      <button type="submit" aria-label="Send reply" disabled={sending || text.trim() === ""}>
        Send
      </button>
    </form>
  );
}
