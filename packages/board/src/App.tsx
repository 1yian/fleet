// The board (spec section 21): an inbox of every card, grouped by what it waits
// on. It updates live and shows when cardd refuses an action.
import { useCallback, useEffect, useRef, useState } from "react";
import type { Board, BoardAction } from "@fleet/protocol";
import { act, loadBoard, unreachable, useChanges } from "./api.ts";
import { BoardIcon, ListIcon } from "./icons.tsx";
import { Inbox, type View } from "./Inbox.tsx";
import { SegmentedControl } from "./vendor/segmented-control.tsx";

/** How often relative times such as "5m ago" refresh. */
const TICK_MS = 30_000;

const typesText = (element: EventTarget | null): boolean =>
  element instanceof HTMLElement &&
  (element.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName));

/** The live board: loaded again on every change, keeping only the newest load. */
function useBoard(changes: number, setNotice: (notice: string | undefined) => void) {
  const [board, setBoard] = useState<Board | undefined>();
  const loads = useRef(0);
  const loadFailed = useRef(false);
  const refresh = useCallback(() => {
    const load = ++loads.current;
    loadBoard().then(
      (loaded) => {
        if (load !== loads.current) return;
        setBoard(loaded);
        if (loadFailed.current) setNotice(undefined);
        loadFailed.current = false;
      },
      (error: unknown) => {
        if (load !== loads.current) return;
        loadFailed.current = true;
        setNotice(unreachable(error));
      },
    );
  }, [setNotice]);
  useEffect(() => {
    refresh();
  }, [changes, refresh]);
  return { board, refresh };
}

function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, TICK_MS);
    return () => {
      clearInterval(timer);
    };
  }, []);
  return now;
}

/** 1 to 9 answer the first question on the board. Escape closes the open card. */
function useKeys(
  board: Board | undefined,
  answer: (card: number, ask: number, choice: string) => void,
  close: () => void,
): void {
  const first = board?.questions[0];
  useEffect(() => {
    const key = (event: KeyboardEvent): void => {
      if (event.key === "Escape") close();
      if (first === undefined || event.repeat || event.metaKey || event.ctrlKey || event.altKey)
        return;
      if (typesText(event.target)) return;
      const choice = first.options[Number(event.key) - 1];
      if (choice !== undefined) answer(first.card, first.ask, choice);
    };
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("keydown", key);
    };
  }, [first, answer, close]);
}

export function App() {
  const changes = useChanges();
  const now = useNow();
  const [notice, setNotice] = useState<string | undefined>();
  const { board, refresh } = useBoard(changes, setNotice);
  const [view, setView] = useState<View>("board");
  const [open, setOpen] = useState<number | undefined>();

  const send = useCallback(
    (card: number, action: BoardAction["action"]) => {
      const revision = board?.cards.find((each) => each.id === card)?.revision ?? 0;
      return act({ card, revision, action }).then((error) => {
        setNotice(error);
        refresh();
        return error;
      });
    },
    [board, refresh],
  );
  const answer = useCallback(
    (card: number, ask: number, choice: string) => {
      void send(card, { kind: "answer", ask, choice });
    },
    [send],
  );
  const close = useCallback(() => {
    setOpen(undefined);
  }, []);
  useKeys(board, answer, close);

  const notices =
    notice === undefined ? null : (
      <p className="notice" role="alert">
        {notice}
      </p>
    );
  if (board === undefined)
    return (
      <main className="board">
        {notices}
        <p className="empty">Loading…</p>
      </main>
    );
  return (
    <main className="board">
      <header className="top">
        <h1>Fleet</h1>
        <SegmentedControl<View>
          aria-label="View"
          className="view-switch"
          value={view}
          onChange={setView}
          options={[
            { value: "board", label: "Board", icon: <BoardIcon /> },
            { value: "list", label: "List", icon: <ListIcon /> },
          ]}
        />
      </header>
      {notices}
      <Inbox
        board={board}
        view={view}
        open={open}
        now={now}
        changes={changes}
        onToggle={(card) => {
          setOpen(open === card ? undefined : card);
        }}
        onAnswer={answer}
        onReply={async (card, text) => {
          const error = await send(card, { kind: "comment", text });
          if (error !== undefined) throw new Error(error);
        }}
        onFail={setNotice}
      />
    </main>
  );
}
