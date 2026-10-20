// A question for the captain: its text, its options, and a way to write his own answer.
import { useState, type KeyboardEvent } from "react";
import type { Question } from "./format.ts";
import { PencilIcon } from "./icons.tsx";

const LONG_OPTION = 32;

interface Props {
  readonly question: Question;
  /** Whether number keys answer this question. */
  readonly keys: boolean;
  /** Resolves true when cardd took the answer. */
  readonly onAnswer: (ask: number, choice: string, written: boolean) => Promise<boolean>;
}

export function Ask({ question, keys, onAnswer }: Props) {
  // Options longer than a few words read better as a list of choices than as buttons in a row.
  const long = question.options.some((option) => option.length > LONG_OPTION);
  const [writing, setWriting] = useState(false);
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
              void onAnswer(question.ask, option, false);
            }}
          >
            {keys && index < 9 ? <kbd>{index + 1}</kbd> : null}
            {option}
          </button>
        ))}
        {writing ? null : (
          <button
            type="button"
            className="write-own"
            onClick={() => {
              setWriting(true);
            }}
          >
            <PencilIcon />
            Write your own
          </button>
        )}
      </div>
      {writing ? (
        <WriteYourOwn
          question={question}
          onAnswer={onAnswer}
          onCancel={() => {
            setWriting(false);
          }}
        />
      ) : null}
    </div>
  );
}

/** Every question can be answered in the captain's own words. A refused answer stays in the box. */
function WriteYourOwn(
  props: Pick<Props, "question" | "onAnswer"> & { readonly onCancel: () => void },
) {
  const { question, onAnswer, onCancel } = props;
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const send = async (): Promise<void> => {
    const words = text.trim();
    if (words === "" || sending) return;
    setSending(true);
    const taken = await onAnswer(question.ask, words, true);
    setSending(false);
    if (taken) onCancel();
  };
  const key = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      // Closes the box, not the card that holds it.
      event.stopPropagation();
      onCancel();
    }
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  };
  return (
    <form
      className="write"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <textarea
        aria-label="Your answer"
        autoFocus
        rows={3}
        value={text}
        placeholder={question.merge ? "What should change?" : "Write your answer"}
        onChange={(event) => {
          setText(event.target.value);
        }}
        onKeyDown={key}
      />
      <div className="write-actions">
        <span className="hint">
          {question.merge ? "Sent as a request for changes. " : ""}
          Enter to send, Shift+Enter for a new line
        </span>
        <button type="button" className="quiet" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="send" disabled={sending || text.trim() === ""}>
          Send answer
        </button>
      </div>
    </form>
  );
}
