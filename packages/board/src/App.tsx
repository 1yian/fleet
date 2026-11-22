import { useCallback, useEffect, useRef, useState } from "react";
import { type Board, type BoardAction } from "@fleet/protocol";
import { act, loadBoard, unreachable, useChanges, type Acted } from "./api.ts";
import { Kanban } from "./Board.tsx";
import { CardDetail, NoCard } from "./CardDetail.tsx";
import { useFacts } from "./facts.ts";
import { deviceZone, questionsByCard } from "./format.ts";
import { useCardRoute } from "./route.ts";
import { ActiveWorkers } from "./ActiveWorkers.tsx";

const TICK_MS = 30_000;

function useBoard(changes: number, tick: number, setNotice: (notice: string | undefined) => void) {
  const [board, setBoard] = useState<Board | undefined>();
  const reading = useRef(false);
  const queued = useRef(false);
  const loadFailed = useRef(false);
  const [available, setAvailable] = useState(false);
  const refresh = useCallback(() => {
    if (reading.current) {
      queued.current = true;
      return;
    }
    reading.current = true;
    void (async () => {
      let again = true;
      while (again) {
        queued.current = false;
        try {
          const loaded = await loadBoard();
          setBoard(loaded);
          setAvailable(true);
          if (loadFailed.current) setNotice(undefined);
          loadFailed.current = false;
        } catch (error) {
          loadFailed.current = true;
          setAvailable(false);
          setNotice(unreachable(error));
        }
        again = queued.current;
      }
      reading.current = false;
    })();
  }, [setNotice]);
  useEffect(() => {
    refresh();
  }, [changes, tick, refresh]);
  return { board, refresh, available };
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

function useDecisions(refresh: () => void, setNotice: (notice: string | undefined) => void) {
  const [notices, setNotices] = useState<ReadonlyMap<number, string>>(new Map());
  const noticeOn = useCallback((card: number, text: string | undefined) => {
    setNotices((all) => {
      const next = new Map(all);
      if (text === undefined) next.delete(card);
      else next.set(card, text);
      return next;
    });
  }, []);
  const send = useCallback(
    async (card: number, action: BoardAction["action"]): Promise<Acted> => {
      const acted = await act({ card, action });
      refresh();
      return acted;
    },
    [refresh],
  );
  const decide = useCallback(
    async (card: number, action: BoardAction["action"]): Promise<boolean> => {
      noticeOn(card, undefined);
      const { error } = await send(card, action);
      noticeOn(card, error);
      return error === undefined;
    },
    [send, noticeOn],
  );
  const answer = useCallback(
    (card: number, hold: number, choice: string, written: boolean) =>
      decide(card, { kind: "answer", hold, choice, ...(written ? { written } : {}) }),
    [decide],
  );
  const later = useCallback(
    async (card: number, hold: number, said: string): Promise<string | undefined> => {
      const { error } = await send(card, {
        kind: "hold",
        hold,
        said,
        zone: deviceZone(),
      });
      return error;
    },
    [send],
  );
  const dismiss = useCallback(
    (card: number) => {
      noticeOn(card, undefined);
    },
    [noticeOn],
  );
  const reply = useCallback(
    async (card: number, text: string): Promise<boolean> => {
      const { error } = await send(card, { kind: "comment", text });
      setNotice(error);
      return error === undefined;
    },
    [send, setNotice],
  );
  return { notices, answer, later, dismiss, reply };
}

function useEscape(close: () => void): void {
  useEffect(() => {
    const key = (event: KeyboardEvent): void => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("keydown", key);
    };
  }, [close]);
}

function BoardNav({ workers }: { readonly workers: boolean }) {
  return (
    <nav className="board-nav" aria-label="Fleet views">
      <a href="#/" aria-current={workers ? undefined : "page"}>
        Board
      </a>
      <a href="#/workers" aria-current={workers ? "page" : undefined}>
        Active Workers
      </a>
    </nav>
  );
}

export function App() {
  const changes = useChanges();
  const now = useNow();
  const [notice, setNotice] = useState<string | undefined>();
  const { board, refresh, available } = useBoard(changes, now, setNotice);
  const { card: open, workers, open: openCard, close } = useCardRoute();
  const [drafts, setDrafts] = useState<ReadonlyMap<number, string>>(new Map());
  const facts = useFacts(board?.cards, now);

  const { notices, answer, later, dismiss, reply } = useDecisions(refresh, setNotice);
  useEscape(close);

  const banner =
    notice === undefined ? null : (
      <p className="notice" role="alert">
        {notice}
      </p>
    );
  if (board === undefined)
    return (
      <main className="board">
        {banner}
        <p className="empty">Loading…</p>
      </main>
    );
  const shown = open === undefined ? undefined : board.cards.find((card) => card.id === open);
  if (open !== undefined)
    return (
      <main className="board detail-page">
        {banner}
        {shown === undefined ? (
          <NoCard id={open} onClose={close} />
        ) : (
          <CardDetail
            key={shown.id}
            card={shown}
            question={questionsByCard(board.holds).get(shown.id)}
            now={now}
            changes={changes}
            draft={drafts.get(shown.id) ?? ""}
            onDraft={(text) => {
              setDrafts((all) => new Map(all).set(shown.id, text));
            }}
            onClose={close}
            notice={notices.get(shown.id)}
            onDismiss={() => {
              dismiss(shown.id);
            }}
            onAnswer={(hold, choice, written) => answer(shown.id, hold, choice, written)}
            onLater={(hold, said) => later(shown.id, hold, said)}
            onReply={(text) => reply(shown.id, text)}
            onFail={setNotice}
          />
        )}
      </main>
    );
  return (
    <main className="kanban">
      <BoardNav workers={workers} />
      {banner}
      {workers ? (
        <ActiveWorkers board={board} available={available} onOpen={openCard} />
      ) : (
        <Kanban
          board={board}
          now={now}
          facts={facts}
          onOpen={openCard}
          notices={notices}
          onAnswer={answer}
          onLater={later}
          onDismiss={dismiss}
        />
      )}
    </main>
  );
}
