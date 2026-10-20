// The card drawer (spec section 21.2): the thread, a reply box, and the option
// buttons, beside the board. Replies go to the lane mate as the captain's words.
import { useEffect, useState } from "react";
import type { Board, Entry, Thread } from "@fleet/protocol";
import { loadThread } from "./api.ts";
import { CommentThread, type ThreadMessage } from "./vendor/comment-thread.tsx";

interface Props {
  readonly card: number;
  readonly board: Board;
  readonly changes: number;
  readonly onReply: (text: string) => void;
  readonly onAnswer: (ask: number, choice: string) => void;
  readonly onClose: () => void;
}

const CAPTAIN = { name: "You" };

function message(entry: Entry): ThreadMessage {
  const who =
    entry.author === "captain"
      ? "You"
      : entry.author.replace(/^mate:/, "").replace(/^worker:/, "worker ");
  const status = typeof entry.fields["status"] === "string" ? `${entry.fields["status"]}: ` : "";
  return {
    id: String(entry.id),
    author: entry.author === "captain" ? CAPTAIN : { name: who },
    createdAt: entry.createdAt,
    text: `${status}${entry.body}`,
  };
}

export function Drawer({ card, board, changes, onReply, onAnswer, onClose }: Props) {
  const [thread, setThread] = useState<Thread | undefined>();
  useEffect(() => {
    void loadThread(card).then(setThread);
  }, [card, changes]);
  const questions = board.questions.filter((each) => each.card === card);
  if (thread === undefined) return <aside className="drawer">Loading c-{card}…</aside>;
  return (
    <aside className="drawer" aria-label={`c-${String(card)}`}>
      <header>
        <h2>
          c-{card} · {thread.card.title}
        </h2>
        <p className="status">
          {thread.card.lane} · {thread.card.status}
          {thread.card.pr === null ? null : (
            <>
              {" · "}
              <a href={thread.card.pr}>PR</a>
            </>
          )}
        </p>
      </header>
      {questions.map((question) => (
        <div className="options" key={question.ask} aria-label={question.question}>
          {question.options.map((option) => (
            <button
              type="button"
              key={option}
              onClick={() => {
                onAnswer(question.ask, option);
              }}
            >
              {option}
            </button>
          ))}
        </div>
      ))}
      <CommentThread
        key={thread.entries.length}
        title="Thread"
        messages={thread.entries.map(message)}
        currentUser={CAPTAIN}
        onReply={(text) => {
          onReply(text);
        }}
        onClose={onClose}
        className="drawer-thread"
      />
    </aside>
  );
}
