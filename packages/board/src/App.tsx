import { useCallback, useEffect, useRef, useState } from "react";
import { type Board, type BoardAction } from "@fleet/protocol";
import { act, loadBoard, unreachable, useChanges, type Acted } from "./api.ts";
import { Kanban } from "./Board.tsx";
import { CardDetail, NoCard } from "./CardDetail.tsx";
import { useFacts } from "./facts.ts";
import { deviceZone, questionsByCard } from "./format.ts";
import { useBrowserRoute, useCardRoute } from "./route.ts";
import { useBrowserLanes } from "./browser-api.ts";
import { BrowserBoardLinks, BrowserPage } from "./Browsers.tsx";
import { ActiveWorkers } from "./ActiveWorkers.tsx";

const TICK_MS = 30_000;

function useBoard(tick: number, setNotice: (notice: string | undefined) => void) {
  const [board, setBoard] = useState<Board | undefined>();
  const epoch = useRef(0);
  const reading = useRef(false);
  const queued = useRef(false);
  const loadFailed = useRef(false);
  const [available, setAvailable] = useState(false);
  const observing = useRef(false);
  const lose = useCallback(() => {
    epoch.current += 1;
    setAvailable(false);
  }, []);
  const changes = useChanges(lose);
  const read = useCallback(async () => {
    if (!observing.current) return;
    const started = epoch.current;
    try {
      const loaded = await loadBoard();
      if (started !== epoch.current) return;
      setBoard(loaded);
      setAvailable(true);
      if (loadFailed.current) setNotice(undefined);
      loadFailed.current = false;
    } catch (error) {
      if (started !== epoch.current) return;
      loadFailed.current = true;
      setAvailable(false);
      setNotice(unreachable(error));
    }
  }, [setNotice]);
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
        await read();
        again = queued.current && observing.current;
      }
      reading.current = false;
    })();
  }, [read]);
  useEffect(() => {
    observing.current = true;
    return () => {
      observing.current = false;
    };
  }, []);
  useEffect(() => {
    refresh();
  }, [changes, tick, refresh]);
  return { board, refresh, available, changes };
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

function Notice({ text }: { readonly text: string | undefined }) {
  return text === undefined ? null : (
    <p className="notice" role="alert">
      {text}
    </p>
  );
}

export function App() {
  const now = useNow();
  const [notice, setNotice] = useState<string | undefined>();
  const { board, refresh, available, changes } = useBoard(now, setNotice);
  const { card: open, workers, open: openCard, close } = useCardRoute();
  const browsersOn = board?.browsers === true;
  const browserRoute = useBrowserRoute(browsersOn);
  const browsers = useBrowserLanes(browsersOn);
  const [drafts, setDrafts] = useState<ReadonlyMap<number, string>>(new Map());
  const facts = useFacts(board?.cards, now);

  const { notices, answer, later, dismiss, reply } = useDecisions(refresh, setNotice);
  useEscape(close);

  const banner = <Notice text={notice} />;
  if (board === undefined)
    return (
      <main className="board">
        {banner}
        <p className="empty">Loading…</p>
      </main>
    );
  if (browserRoute !== undefined) return <BrowserPage lane={browserRoute.lane} {...browsers} />;
  if (open !== undefined) {
    const shown = board.cards.find((card) => card.id === open);
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
  }
  return (
    <main className="kanban">
      {workers ? null : <BrowserBoardLinks enabled={board.browsers} {...browsers} />}
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
