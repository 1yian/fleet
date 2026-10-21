import type { DatabaseSync } from "node:sqlite";
import { check, PlanSchema, type Plan } from "@fleet/protocol";
import Type, { type Static } from "typebox";
import { timeZoneProblem } from "./schedule.ts";
import { laneCardOf } from "./store.ts";

const ActivePlanSchema = Type.Object({ ...PlanSchema.properties, since: Type.Integer() });
export type ActivePlan = Static<typeof ActivePlanSchema>;

const NO_PLAN: Plan = { goal: "", timezone: "UTC", wakes: [] };

export function parsePlan(text: string): Plan {
  const plan = check(PlanSchema, JSON.parse(text));
  const problem = timeZoneProblem(plan.timezone);
  if (problem !== undefined) throw new Error(`invalid /timezone: ${problem}`);
  return plan;
}

function planCard(db: DatabaseSync, lane: string): number {
  const card = laneCardOf(db, lane);
  if (card === undefined)
    throw new Error(`lane ${lane} has no lane card, so it has no plan: only a second mate has one`);
  return card;
}

const column = (db: DatabaseSync, card: number, name: "plan" | "plan_next"): unknown => {
  const text = db.prepare(`SELECT ${name} AS j FROM cards WHERE id = ?`).get(card)?.["j"];
  return typeof text === "string" ? JSON.parse(text) : null;
};

const activeOf = (db: DatabaseSync, card: number): ActivePlan | null => {
  const value = column(db, card, "plan");
  return value === null ? null : check(ActivePlanSchema, value);
};

const nextOf = (db: DatabaseSync, card: number): Plan | null => {
  const value = column(db, card, "plan_next");
  return value === null ? null : check(PlanSchema, value);
};

export function setNextPlan(db: DatabaseSync, lane: string, plan: Plan): void {
  db.prepare("UPDATE cards SET plan_next = ? WHERE id = ?").run(
    JSON.stringify(plan),
    planCard(db, lane),
  );
}

export function showPlans(
  db: DatabaseSync,
  lane: string,
): { active: ActivePlan | null; next: Plan | null } {
  const card = planCard(db, lane);
  return { active: activeOf(db, card), next: nextOf(db, card) };
}

export function loadPlan(db: DatabaseSync, lane: string, now: number): Plan {
  const card = laneCardOf(db, lane);
  if (card === undefined) return NO_PLAN;
  const next = nextOf(db, card);
  if (next !== null) {
    const taken = JSON.stringify({ ...next, since: now });
    db.prepare("UPDATE cards SET plan = ?, plan_next = NULL WHERE id = ?").run(taken, card);
    return next;
  }
  const active = activeOf(db, card);
  if (active === null) return NO_PLAN;
  return { goal: active.goal, timezone: active.timezone, wakes: active.wakes };
}

export function activePlans(db: DatabaseSync): { lane: string; card: number; plan: ActivePlan }[] {
  return db
    .prepare("SELECT name, card FROM lanes WHERE card IS NOT NULL AND parent IS NOT NULL")
    .all()
    .flatMap((row) => {
      const card = Number(row["card"]);
      const plan = activeOf(db, card);
      return plan === null ? [] : [{ lane: String(row["name"]), card, plan }];
    });
}
