import type { DatabaseSync } from "node:sqlite";
import { remaining } from "./incident-kinds.ts";
import type { Incident } from "./incident-store.ts";
import { addEntry } from "./store.ts";

export const stamp = (ms: number): string => new Date(ms).toISOString();

export function nextStep(inc: Incident): string {
  const modes = remaining(inc);
  if (inc.intent !== "working")
    return `Its card is ${inc.intent}, so recovery is not offered and nothing is resumed.`;
  if (modes.length === 0)
    return `Restarting is not a repair for ${inc.classification}: it needs intervention, not recovery.`;
  const when = inc.eligibleAt === null ? "." : `, eligible at ${stamp(inc.eligibleAt)}.`;
  return `Recover with recover(incident=${String(inc.id)}, generation=${String(inc.generation)}, mode=${modes.join(" or ")})${when}`;
}

export function describe(inc: Incident, label: string): string {
  const what = {
    turn: "its model turn failed",
    startup: "it never connected after starting",
    lost: "its process stopped without a final event",
  }[inc.phase];
  const cause = inc.phase === "turn" ? `: ${inc.error}` : "";
  const ids = `Incident ${String(inc.id)}, process generation ${String(inc.generation)}.`;
  return `runtime failure: ${label} ${what}${cause}. Classified ${inc.classification}. ${ids} ${nextStep(inc)}`;
}

export function labelOf(inc: Incident, role: "mate" | "worker"): string {
  return role === "worker" ? `the worker on c-${String(inc.card)}` : inc.actor;
}

export function tell(
  db: DatabaseSync,
  inc: Incident,
  role: "mate" | "worker",
  body: string,
): string[] {
  const fields = { condition: "runtime-failure", incident: inc.id, role };
  if (inc.parent === null) {
    const hold = { ...fields, holder: "captain", options: [], merge: false, until: null };
    addEntry(db, { card: inc.card, author: "check", kind: "hold", body, fields: hold }, []);
    return [];
  }
  addEntry(db, { card: inc.card, author: "check", kind: "finding", body, fields }, [inc.parent]);
  return [inc.parent];
}
