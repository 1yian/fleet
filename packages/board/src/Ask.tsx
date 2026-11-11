import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { MERGE_OPTIONS } from "@fleet/protocol";
import { deviceZone, type Question } from "./format.ts";
import { ClockIcon, PenIcon } from "./icons.tsx";
import { Rich } from "./Rich.tsx";

const PRESETS = [
  { label: "In 3 hours", said: "in 3 hours" },
  { label: "Tomorrow 09:00", said: "tomorrow 09:00" },
  { label: "Monday 09:00", said: "Monday 09:00" },
] as const;

interface Props {
  readonly question: Question;
  readonly showQuestion: boolean;
  readonly onRead: (() => void) | undefined;
  readonly onAnswer: (hold: number, choice: string, written: boolean) => Promise<boolean>;
  readonly onLater: (hold: number, said: string) => Promise<string | undefined>;
}

type Mode = "options" | "words" | "later";

export function Ask(props: Props) {
  const { question } = props;
  return (
    <div className="ask">
      {props.showQuestion ? <Question text={question.question} onRead={props.onRead} /> : null}
      <AskBody key={question.hold} {...props} />
    </div>
  );
}

function Question(props: { readonly text: string; readonly onRead: (() => void) | undefined }) {
  const { onRead } = props;
  const clamp = onRead !== undefined;
  const box = useRef<HTMLParagraphElement>(null);
  const [clipped, setClipped] = useState(false);
  useLayoutEffect(() => {
    const element = box.current;
    if (element === null || !clamp) return;
    const measure = (): void => {
      setClipped(element.scrollHeight > element.clientHeight + 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [props.text, clamp]);
  return (
    <div className="question">
      <p ref={box} className={clamp ? "ask-text clamped" : "ask-text"}>
        <Rich text={props.text} />
      </p>
      {onRead !== undefined && clipped ? (
        <button type="button" className="read" onClick={onRead}>
          Read
        </button>
      ) : null}
    </div>
  );
}

function AskBody(props: Props) {
  const { question } = props;
  const [mode, setMode] = useState<Mode>("options");
  const toOptions = (): void => {
    setMode("options");
  };
  const changes = (option: string): boolean => question.merge && option === MERGE_OPTIONS[1];
  return (
    <>
      <div className="options">
        {question.options.map((option, index) => (
          <button
            type="button"
            key={option}
            className={index === 0 ? "option primary" : "option"}
            onClick={() => {
              if (changes(option)) setMode("words");
              else void props.onAnswer(question.hold, option, false);
            }}
          >
            {option}
          </button>
        ))}
      </div>
      {mode === "words" ? (
        <Words question={question} onAnswer={props.onAnswer} onCancel={toOptions} />
      ) : null}
      {mode === "later" ? (
        <Later onLater={(said) => props.onLater(question.hold, said)} onCancel={toOptions} />
      ) : null}
      {mode === "options" ? (
        <div className="ask-foot">
          {question.merge ? null : (
            <button
              type="button"
              className="quiet-action"
              onClick={() => {
                setMode("words");
              }}
            >
              <PenIcon />
              Your words
            </button>
          )}
          <button
            type="button"
            className="quiet-action"
            onClick={() => {
              setMode("later");
            }}
          >
            <ClockIcon />
            Later
          </button>
        </div>
      ) : null}
    </>
  );
}

function Words(props: {
  readonly question: Question;
  readonly onAnswer: Props["onAnswer"];
  readonly onCancel: () => void;
}) {
  const { question, onAnswer, onCancel } = props;
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const send = async (): Promise<void> => {
    const words = text.trim();
    if (words === "" || sending) return;
    setSending(true);
    const taken = await onAnswer(question.hold, words, true);
    setSending(false);
    if (taken) onCancel();
  };
  const key = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.stopPropagation();
      onCancel();
    }
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  };
  const prompt = question.merge ? "What should change before it merges?" : "Your answer";
  return (
    <form
      className="write"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <label className="write-prompt" htmlFor={`words-${String(question.hold)}`}>
        {prompt}
      </label>
      <textarea
        id={`words-${String(question.hold)}`}
        aria-label="Your words"
        autoFocus
        rows={3}
        value={text}
        placeholder={question.merge ? "Say what to fix" : "Write your answer"}
        onChange={(event) => {
          setText(event.target.value);
        }}
        onKeyDown={key}
      />
      <div className="write-actions">
        <p className="hint">
          {question.merge
            ? "Goes to main as your words, and the card goes back to the worker."
            : "Goes to main as your words."}
        </p>
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

function Later(props: {
  readonly onLater: (said: string) => Promise<string | undefined>;
  readonly onCancel: () => void;
}) {
  const inputId = useId();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | undefined>();
  const send = async (said: string): Promise<void> => {
    const words = said.trim();
    if (words === "" || sending) return;
    setSending(true);
    setProblem(await props.onLater(words));
    setSending(false);
  };
  const key = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.stopPropagation();
      props.onCancel();
    }
  };
  return (
    <div className="later" role="group" aria-label="Ask me later">
      {PRESETS.map((preset) => (
        <button
          type="button"
          key={preset.label}
          className="option later-option"
          disabled={sending}
          onClick={() => {
            void send(preset.said);
          }}
        >
          {preset.label}
        </button>
      ))}
      <form
        className="write"
        onSubmit={(event) => {
          event.preventDefault();
          void send(text);
        }}
      >
        <label className="write-prompt" htmlFor={inputId}>
          Or say when
        </label>
        <input
          id={inputId}
          type="text"
          aria-label="Until when"
          autoFocus
          autoComplete="off"
          value={text}
          placeholder="Friday 4PM, Nov 20, in 2 hours"
          onChange={(event) => {
            setText(event.target.value);
          }}
          onKeyDown={key}
        />
        {problem === undefined ? null : (
          <p className="later-problem" role="alert">
            {problem}
          </p>
        )}
        <div className="write-actions">
          <p className="hint">
            It comes back to you then. A time with no zone is read in {deviceZone()}.
          </p>
          <button type="button" className="quiet" onClick={props.onCancel}>
            Cancel
          </button>
          <button type="submit" className="send" disabled={sending || text.trim() === ""}>
            Hold until then
          </button>
        </div>
      </form>
    </div>
  );
}
