// The board (spec section 21): Needs you by default, Kanban beside it, and a
// card drawer. It updates live and shows when cardd refuses an action.
import { useCallback, useEffect, useState } from "react";
import type { Board, BoardAction } from "@fleet/protocol";
import { act, loadBoard, useChanges } from "./api.ts";
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
  useEffect(() => {
    void loadBoard().then(setBoard);
  }, [changes]);

  const send = useCallback(
    (card: number, action: BoardAction["action"]) => {
      const revision = board?.cards.find((each) => each.id === card)?.revision ?? 0;
      void act({ card, revision, action }).then((error) => {
        setNotice(error);
        void loadBoard().then(setBoard);
      });
    },
    [board],
  );
  const answer = useCallback(
    (card: number, choice: string) => {
      send(card, { kind: "answer", choice });
    },
    [send],
  );

  if (board === undefined) return <main className="board">Loading…</main>;
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
      {notice === undefined ? null : (
        <p className="notice" role="alert">
          {notice}
        </p>
      )}
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
          onAnswer={(choice) => {
            answer(open, choice);
          }}
          onReply={(text) => {
            send(open, { kind: "comment", text });
          }}
          onClose={() => {
            setOpen(undefined);
          }}
        />
      )}
    </main>
  );
}
