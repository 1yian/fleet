import type { DatabaseSync } from "node:sqlite";
import type { OpArgs } from "@fleet/protocol";
import { activePlans } from "./plans.ts";
import { unansweredWake } from "./replies.ts";
import { dueSlots, type Slot } from "./schedule.ts";
import { addEntry, cardEntries, laneCardOf, parentOf } from "./store.ts";

const SCHEDULE = "schedule";
const SCRIPT = "script";

const slotKey = ({ minute, purpose }: Slot): string => `${minute}|${purpose}`;

function issued(db: DatabaseSync, card: number, key: string): boolean {
  const found = db
    .prepare(
      `SELECT 1 FROM entries e, json_each(e.fields, '$.slots') j
       WHERE e.card = ? AND j.value = ? LIMIT 1`,
    )
    .get(card, key);
  return found !== undefined;
}

export function scheduledWakes(db: DatabaseSync, now: number): string[] {
  return activePlans(db).flatMap(({ lane, card, plan }) => {
    const due = dueSlots(plan, plan.since, now).filter((slot) => !issued(db, card, slotKey(slot)));
    const parent = parentOf(db, lane);
    if (due.length === 0 || parent === null) return [];
    const minute =
      due
        .map((slot) => slot.minute)
        .sort()
        .at(-1) ?? "";
    const at = `${minute} ${plan.timezone}`;
    const slots = due.map(slotKey);
    const waiting = unansweredWake(cardEntries(db, card));
    if (waiting !== undefined) {
      const body = `scheduled wake ${at} skipped: ${waiting.id} is still unanswered`;
      addEntry(
        db,
        {
          card,
          author: SCHEDULE,
          kind: "note",
          body,
          fields: { condition: "wake-skipped", slots },
        },
        [],
      );
      return [];
    }
    const late = (slot: Slot): string =>
      slot.minute === minute ? slot.purpose : `${slot.purpose} [due ${slot.minute}]`;
    const body = `scheduled wake ${at}: ${due.map(late).join("; ")}`;
    const fields = { for: "mate", owes: lane, from: parent, wake: "scheduled", slots };
    addEntry(db, { card, author: SCHEDULE, kind: "comment", body, fields }, [lane]);
    return [lane];
  });
}

export function scriptWake(db: DatabaseSync, lane: string, args: OpArgs<"wake">): number {
  const card = laneCardOf(db, lane);
  if (card === undefined)
    throw new Error(`lane ${lane} has no lane card, so a script cannot wake it`);
  const name = args.script ?? SCRIPT;
  const fields = { for: "mate", wake: "script" };
  const body = `script wake ${name}: ${args.note}`;
  return addEntry(db, { card, author: SCRIPT, kind: "comment", body, fields }, [lane]);
}
