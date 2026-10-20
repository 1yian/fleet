// The board (spec section 21): Needs you by default, Kanban beside it, and a
// card drawer. It updates live and shows when cardd refuses an action.
import { useCallback, useEffect, useRef, useState } from "react";
import type { Board, BoardAction } from "@fleet/protocol";
import { act, loadBoard, unreachable, useChanges } from "./api.ts";
import { Drawer } from "./Drawer.tsx";
import { Kanban } from "./Kanban.tsx";
import { NeedsYou } from "./NeedsYou.tsx";
import { SegmentedControl } from "./vendor/segmented-control.tsx";

type View = "needs-you" | "kanban";

export function App() {
  const changes = useChanges();
  const [board, setBoard] = useState<Board | undefined>();
  const [view, setView] = useState<View>("needs-you");
  const [open, setOpen] = useState<number | undefined>();
  const [notice, setNotice] = useState<string | undefined>();
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
  }, []);
  useEffect(() => {
    refresh();
  }, [changes, refresh]);

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
        Loading…
      </main>
    );
  return (
    <main className="board">
      <header className="top">
        <h1>Fleet</h1>
        <SegmentedControl<View>
          aria-label="View"
          value={view}
          onChange={setView}
          options={[
            { value: "needs-you", label: "Needs you", count: board.questions.length },
            { value: "kanban", label: "Kanban", count: board.cards.length },
          ]}
        />
      </header>
      {notices}
      {view === "needs-you" ? (
        <NeedsYou board={board} onAnswer={answer} onOpen={setOpen} />
      ) : (
        <Kanban board={board} onOpen={setOpen} />
      )}
      {open === undefined ? null : (
        <Drawer
          card={open}
          board={board}
          changes={changes}
          onFail={setNotice}
          onAnswer={(ask, choice) => {
            answer(open, ask, choice);
          }}
          onReply={async (text) => {
            const error = await send(open, { kind: "comment", text });
            if (error !== undefined) throw new Error(error);
          }}
          onClose={() => {
            setOpen(undefined);
          }}
        />
      )}
    </main>
  );
}
