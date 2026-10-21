import { useCallback, useEffect, useRef, useState } from "react";
import type { Board, BoardAction } from "@fleet/protocol";
import { act, loadBoard, unreachable, useChanges } from "./api.ts";
import { Kanban } from "./Board.tsx";
import { CardDetail, NoCard } from "./CardDetail.tsx";
import { useFacts } from "./facts.ts";
import { questionsByCard } from "./format.ts";
import { useCardRoute } from "./route.ts";
import { TopBar } from "./TopBar.tsx";

const TICK_MS = 30_000;

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

function useDecisions(
  board: Board | undefined,
  refresh: () => void,
  setNotice: (notice: string | undefined) => void,
) {
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
    async (card: number, action: BoardAction["action"]): Promise<string | undefined> => {
      const revision = board?.cards.find((each) => each.id === card)?.revision ?? 0;
      const error = await act({ card, revision, action });
      refresh();
      return error;
    },
    [board, refresh],
  );
  const decide = useCallback(
    async (card: number, action: BoardAction["action"]): Promise<boolean> => {
      noticeOn(card, undefined);
      const error = await send(card, action);
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
    (card: number, until: number, reason: string) => {
      void decide(card, { kind: "hold", until, reason });
    },
    [decide],
  );
  const dismiss = useCallback(
    (card: number) => {
      noticeOn(card, undefined);
    },
    [noticeOn],
  );
  const reply = useCallback(
    async (card: number, text: string): Promise<boolean> => {
      const error = await send(card, { kind: "comment", text });
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

export function App() {
  const changes = useChanges();
  const now = useNow();
  const [notice, setNotice] = useState<string | undefined>();
  const { board, refresh } = useBoard(changes, setNotice);
  const [lane, setLane] = useState<string | undefined>();
  const { card: open, open: openCard, close } = useCardRoute();
  const [drafts, setDrafts] = useState<ReadonlyMap<number, string>>(new Map());
  const facts = useFacts(board?.cards, now);

  const { notices, answer, later, dismiss, reply } = useDecisions(board, refresh, setNotice);
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
            onLater={(until, reason) => {
              later(shown.id, until, reason);
            }}
            onReply={(text) => reply(shown.id, text)}
            onFail={setNotice}
          />
        )}
      </main>
    );
  const selected = board.cards.some((card) => card.lane === lane) ? lane : undefined;
  return (
    <main className="kanban">
      <TopBar cards={board.cards} waiting={board.holds.length} lane={selected} onLane={setLane} />
      {banner}
      <Kanban
        board={board}
        lane={selected}
        now={now}
        facts={facts}
        onOpen={openCard}
        notices={notices}
        onAnswer={answer}
        onLater={later}
        onDismiss={dismiss}
      />
    </main>
  );
}
