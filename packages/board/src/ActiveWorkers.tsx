import { isScheduleLog, type Board, type BoardCard } from "@fleet/protocol";
import { phraseOf } from "./format.ts";
import { StatusIcon, type Glyph } from "./icons.tsx";
import { TitleLink } from "./TaskCard.tsx";
import { idLabel } from "./text.ts";
import "./workers.css";

type Group = "working" | "waiting" | "offline";

const GROUPS: readonly { key: Group; title: string; icon: Glyph; empty: string }[] = [
  { key: "working", title: "Working", icon: "working", empty: "No workers are working now." },
  { key: "waiting", title: "Waiting", icon: "later", empty: "No workers are waiting." },
  {
    key: "offline",
    title: "Disconnected or stale",
    icon: "dropped",
    empty: "No workers are disconnected or stale.",
  },
];

interface Worker {
  readonly card: BoardCard;
  readonly group: Group;
  readonly status: string;
}

function workerOf(card: BoardCard, staleBefore: number): Worker | undefined {
  const { activity } = card;
  if (card.mate || isScheduleLog(card) || activity === null) return undefined;
  if (activity.state === "starting") return { card, group: "offline", status: "Not yet connected" };
  if (activity.state === "lost" || activity.state === "exited")
    return { card, group: "offline", status: "Disconnected" };
  if (activity.state === "running" && activity.at <= staleBefore)
    return { card, group: "offline", status: "Stale activity" };
  if (card.holder !== null || card.status !== "working")
    return { card, group: "waiting", status: phraseOf(card, false) };
  if (activity.state === "running") return { card, group: "working", status: "Running" };
  return {
    card,
    group: "waiting",
    status: activity.state === "waiting" ? "Waiting on a job" : "Idle",
  };
}

export function ActiveWorkers(props: {
  readonly board: Board;
  readonly available: boolean;
  readonly onOpen: (card: number) => void;
}) {
  const { board, available, onOpen } = props;
  const groups: Record<Group, Worker[]> = { working: [], waiting: [], offline: [] };
  if (available) {
    for (const card of board.cards) {
      const worker = workerOf(card, board.workerStaleBefore);
      if (worker !== undefined) groups[worker.group].push(worker);
    }
  }

  return (
    <div className="workers">
      <header className="workers-heading">
        <h1>Active Workers</h1>
        <p>Current worker attempts across all lanes.</p>
      </header>
      {!available ? (
        <p className="workers-unavailable">Worker status is unavailable until cardd reconnects.</p>
      ) : (
        GROUPS.map(({ key, title, icon, empty }) => (
          <section className="worker-group" data-state={key} key={key} aria-label={title}>
            <header>
              <StatusIcon glyph={icon} />
              <h2>{title}</h2>
              <span className="n">{groups[key].length}</span>
            </header>
            {groups[key].length === 0 ? (
              <p className="workers-empty">{empty}</p>
            ) : (
              <ul>
                {groups[key].map(({ card, status }) => (
                  <li key={card.id}>
                    <div>
                      <TitleLink
                        card={card}
                        onOpen={() => {
                          onOpen(card.id);
                        }}
                      />
                      <p className="worker-meta">
                        <span className="id">{idLabel(card.id)}</span> · {card.lane}
                      </p>
                    </div>
                    <span className="chip worker-status">{status}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))
      )}
    </div>
  );
}
