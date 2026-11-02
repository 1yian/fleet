import type { DatabaseSync } from "node:sqlite";
import { check, MAX_SCHEDULES, OPS, type OpArgs, type Schedule } from "@fleet/protocol";
import { dueSlots, localMinute, timeZoneProblem } from "./schedule.ts";
import { addCard, addEntry, laneCardOf, mainLane } from "./store.ts";

const AUTHOR = "schedule";
const MAIN_CARD = "scheduled-messages";

interface Row extends Schedule {
  readonly since: number;
  readonly fired: string | null;
}

const rowOf = (raw: Record<string, unknown>): Row => ({
  id: Number(raw["id"]),
  owner: String(raw["owner"]),
  to: String(raw["recipient"]),
  at: String(raw["at"]),
  timezone: String(raw["timezone"]),
  on: typeof raw["on_date"] === "string" ? raw["on_date"] : null,
  text: String(raw["text"]),
  since: Number(raw["since"]),
  fired: typeof raw["fired"] === "string" ? raw["fired"] : null,
});

const shown = ({ since: _since, fired: _fired, ...schedule }: Row): Schedule => schedule;

function rows(db: DatabaseSync): Row[] {
  return db.prepare("SELECT * FROM schedules ORDER BY id").all().map(rowOf);
}

export const allSchedules = (db: DatabaseSync): Schedule[] => rows(db).map(shown);

export function listSchedules(db: DatabaseSync, lane: string): Schedule[] {
  const everything = allSchedules(db);
  return lane === mainLane(db) ? everything : everything.filter(({ owner }) => owner === lane);
}

function requireLane(db: DatabaseSync, name: string): void {
  if (db.prepare("SELECT 1 FROM lanes WHERE name = ?").get(name) === undefined)
    throw new Error(`no lane ${name}: a schedule can deliver only to main or a second mate`);
}

function requireOwn(db: DatabaseSync, lane: string, id: number): Row {
  const found = rows(db).find((row) => row.id === id);
  if (found === undefined) throw new Error(`no schedule ${String(id)}`);
  if (found.owner !== lane)
    throw new Error(`schedule ${String(id)} belongs to ${found.owner}, so only it can change it`);
  return found;
}

function checkedWhen(args: OpArgs<"schedule.set">, now: number): void {
  const problem = timeZoneProblem(args.timezone);
  if (problem !== undefined) throw new Error(`invalid timezone: ${problem}`);
  if (args.on === undefined) return;
  const parsed = new Date(`${args.on}T00:00:00Z`);
  const valid = !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === args.on;
  if (!valid) throw new Error(`${args.on} is not a date`);
  if (`${args.on}T${args.at}` <= localMinute(now, args.timezone))
    throw new Error(`${args.on} ${args.at} ${args.timezone} has already passed`);
}

export function setSchedule(db: DatabaseSync, lane: string, raw: unknown, now: number): Schedule {
  const args = check(OPS["schedule.set"].args, raw);
  requireLane(db, args.to);
  checkedWhen(args, now);
  const values = [args.to, args.at, args.on ?? null, args.timezone, args.text, now];
  if (args.id !== undefined) {
    requireOwn(db, lane, args.id);
    db.prepare(
      `UPDATE schedules SET recipient = ?, at = ?, on_date = ?, timezone = ?, text = ?,
         since = ?, fired = NULL WHERE id = ?`,
    ).run(...values, args.id);
    return listSchedules(db, lane).find(({ id }) => id === args.id) ?? failed();
  }
  const own = rows(db).filter(({ owner }) => owner === lane).length;
  if (own >= MAX_SCHEDULES)
    throw new Error(`you have ${String(own)} schedules: remove one before you add another`);
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO schedules (owner, recipient, at, on_date, timezone, text, since)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(lane, ...values);
  return listSchedules(db, lane).find(({ id }) => id === Number(lastInsertRowid)) ?? failed();
}

const failed = (): never => {
  throw new Error("the schedule was not saved");
};

export function removeSchedule(db: DatabaseSync, lane: string, id: number): void {
  requireOwn(db, lane, id);
  db.prepare("DELETE FROM schedules WHERE id = ?").run(id);
}

function dueMinute(row: Row, now: number): string | undefined {
  if (row.on !== null) {
    const minute = `${row.on}T${row.at}`;
    return minute <= localMinute(now, row.timezone) ? minute : undefined;
  }
  const plan = {
    goal: "",
    timezone: row.timezone,
    wakes: [{ at: row.at, purpose: "" }],
  };
  return dueSlots(plan, row.since, now)[0]?.minute;
}

function cardFor(db: DatabaseSync, recipient: string): number {
  const lane = laneCardOf(db, recipient);
  if (lane !== undefined) return lane;
  const found = db
    .prepare("SELECT id FROM cards WHERE lane = ? AND kind = 'standing' AND name = ?")
    .get(recipient, MAIN_CARD)?.["id"];
  if (typeof found === "number") return found;
  return addCard(db, {
    lane: recipient,
    title: "Scheduled messages",
    name: MAIN_CARD,
    kind: "standing",
  }).id;
}

export function firedSchedules(db: DatabaseSync, now: number): string[] {
  return rows(db).flatMap((row) => {
    const minute = dueMinute(row, now);
    if (minute === undefined || (row.fired !== null && minute <= row.fired)) return [];
    const fields = {
      for: "mate",
      wake: "message",
      from: row.owner,
      schedule: row.id,
      slot: minute,
    };
    addEntry(
      db,
      { card: cardFor(db, row.to), author: AUTHOR, kind: "comment", body: row.text, fields },
      [row.to],
    );
    if (row.on === null)
      db.prepare("UPDATE schedules SET fired = ? WHERE id = ?").run(minute, row.id);
    else db.prepare("DELETE FROM schedules WHERE id = ?").run(row.id);
    return [row.to];
  });
}
