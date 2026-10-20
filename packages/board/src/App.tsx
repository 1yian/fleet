// The board (spec section 21): an inbox of every card, grouped by what it waits
// on. It updates live and shows when cardd refuses an action.
import { useCallback, useEffect, useRef, useState } from "react";
import type { Board, BoardAction } from "@fleet/protocol";
import { act, loadBoard, unreachable, useChanges } from "./api.ts";
import { BoardIcon, ListIcon } from "./icons.tsx";
import { CardDetail, NoCard } from "./CardDetail.tsx";
import { questionsByCard } from "./format.ts";
import { Inbox, type View } from "./Inbox.tsx";
import { useCardRoute } from "./route.ts";
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

/** 1 to 9 answer the first question of the open card, or of the board. Escape closes the open card. */
function useKeys(
  board: Board | undefined,
  open: number | undefined,
  answer: (card: number, hold: number, choice: string, written: boolean) => Promise<boolean>,
  close: () => void,
): void {
  const first = board?.holds.find((question) => open === undefined || question.card === open);
  useEffect(() => {
    const key = (event: KeyboardEvent): void => {
      if (event.key === "Escape") close();
      if (first === undefined || event.repeat || event.metaKey || event.ctrlKey || event.altKey)
        return;
      if (typesText(event.target)) return;
      const choice = first.options[Number(event.key) - 1];
      if (choice !== undefined) void answer(first.card, first.hold, choice, false);
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
  const { card: open, open: openCard, close } = useCardRoute();
  // What the captain started to write on each card, kept when he goes back to the board.
  const [drafts, setDrafts] = useState<ReadonlyMap<number, string>>(new Map());

  /** Sends one action. Resolves true when cardd took it. */
  const send = useCallback(
    async (card: number, action: BoardAction["action"]): Promise<boolean> => {
      const revision = board?.cards.find((each) => each.id === card)?.revision ?? 0;
      const error = await act({ card, revision, action });
      setNotice(error);
      refresh();
      return error === undefined;
    },
    [board, refresh],
  );
  const answer = useCallback(
    (card: number, hold: number, choice: string, written: boolean) =>
      send(card, { kind: "answer", hold, choice, ...(written ? { written } : {}) }),
    [send],
  );
  useKeys(board, open, answer, close);

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
  const shown = open === undefined ? undefined : board.cards.find((card) => card.id === open);
  if (open !== undefined)
    return (
      <main className="board detail-page">
        {notices}
        {shown === undefined ? (
          <NoCard id={open} onClose={close} />
        ) : (
          <CardDetail
            key={shown.id}
            card={shown}
            questions={questionsByCard(board.holds).get(shown.id) ?? []}
            now={now}
            changes={changes}
            draft={drafts.get(shown.id) ?? ""}
            onDraft={(text) => {
              setDrafts((all) => new Map(all).set(shown.id, text));
            }}
            onClose={close}
            onAnswer={(hold, choice, written) => answer(shown.id, hold, choice, written)}
            onReply={(text) => send(shown.id, { kind: "comment", text })}
            onFail={setNotice}
          />
        )}
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
      <Inbox board={board} view={view} now={now} onOpen={openCard} onAnswer={answer} />
    </main>
  );
}
