import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { MERGE_OPTIONS } from "@fleet/protocol";
import type { Question } from "./format.ts";
import { ClockIcon, PenIcon } from "./icons.tsx";

const HOUR = 3_600_000;
const MORNING = 9;
const MONDAY = 1;

interface Props {
  readonly question: Question;
  readonly showQuestion: boolean;
  readonly onRead: (() => void) | undefined;
  readonly onAnswer: (hold: number, choice: string, written: boolean) => Promise<boolean>;
  readonly onLater: (until: number, reason: string) => void;
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
        {props.text}
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
      {mode === "later" ? <Later onLater={props.onLater} onCancel={toOptions} /> : null}
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

interface Preset {
  readonly label: string;
  readonly until: number;
}

function presets(now: number): Preset[] {
  const morning = (days: number): number => {
    const day = new Date(now);
    day.setDate(day.getDate() + days);
    return day.setHours(MORNING, 0, 0, 0);
  };
  const untilMonday = (MONDAY + 7 - new Date(now).getDay()) % 7 || 7;
  return [
    { label: "In 3 hours", until: now + 3 * HOUR },
    { label: `Tomorrow ${String(MORNING).padStart(2, "0")}:00`, until: morning(1) },
    { label: `Monday ${String(MORNING).padStart(2, "0")}:00`, until: morning(untilMonday) },
  ];
}

function Later(props: { readonly onLater: Props["onLater"]; readonly onCancel: () => void }) {
  const [options] = useState(() => presets(Date.now()));
  return (
    <div className="later" role="group" aria-label="Ask me later">
      {options.map((preset) => (
        <button
          type="button"
          key={preset.label}
          className="option later-option"
          onClick={() => {
            props.onLater(preset.until, `Put off from the board until ${preset.label}`);
          }}
        >
          {preset.label}
        </button>
      ))}
      <button type="button" className="quiet" onClick={props.onCancel}>
        Cancel
      </button>
    </div>
  );
}
