import type { DatabaseSync } from "node:sqlite";
import { addCard, laneCardOf, type Session } from "./store.ts";

export function cardOfActor(db: DatabaseSync, session: Session, error: string): number {
  if (session.card !== null) return session.card;
  const lane = laneCardOf(db, session.lane);
  if (lane !== undefined) return lane;
  return addCard(db, {
    lane: session.lane,
    title: `${session.lane} runtime failure`,
    name: `${session.lane}-runtime-failure`,
    kind: "captain",
    intent: `${session.lane} hit a runtime failure: ${error}`,
  }).id;
}
