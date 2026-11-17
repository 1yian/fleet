import type { DatabaseSync } from "node:sqlite";
import { addCard } from "./store.ts";

export function logCardOf(db: DatabaseSync, lane: string, name: string, title: string): number {
  const found = db
    .prepare("SELECT id FROM cards WHERE lane = ? AND kind = 'standing' AND name = ?")
    .get(lane, name)?.["id"];
  return typeof found === "number"
    ? found
    : addCard(db, { lane, title, name, kind: "standing" }).id;
}
