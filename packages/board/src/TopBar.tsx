import type { BoardCard } from "@fleet/protocol";
import { lanesOf } from "./format.ts";
import { BrandMark } from "./icons.tsx";
import { LaneAvatar } from "./TaskCard.tsx";

interface Props {
  readonly cards: readonly BoardCard[];
  readonly waiting: number;
  readonly lane: string | undefined;
  readonly onLane: (lane: string | undefined) => void;
}

export function TopBar({ cards, waiting, lane, onLane }: Props) {
  const lanes = lanesOf(cards);
  return (
    <header className="top">
      <h1 className="brand">
        <BrandMark />
        Fleet
      </h1>
      {lanes.length < 2 ? null : (
        <nav className="lanes" aria-label="Lanes">
          <button
            type="button"
            className="lane-chip"
            aria-pressed={lane === undefined}
            onClick={() => {
              onLane(undefined);
            }}
          >
            All lanes
          </button>
          {lanes.map((name) => (
            <button
              type="button"
              key={name}
              className="lane-chip"
              aria-pressed={lane === name}
              onClick={() => {
                onLane(name);
              }}
            >
              <LaneAvatar lane={name} />
              {name}
            </button>
          ))}
        </nav>
      )}
      <p className={waiting === 0 ? "for-you clear" : "for-you"}>
        <span className="dot" aria-hidden="true" />
        {waiting === 0 ? "Nothing for you" : `${String(waiting)} for you`}
      </p>
    </header>
  );
}
