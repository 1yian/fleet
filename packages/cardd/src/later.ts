import { LATER_EXAMPLES, type LaterResult } from "@fleet/protocol";
import { localMinute, shiftDays, timeZoneProblem, weekdayOf } from "./schedule.ts";
import { DAY, MORNING, scan, two, type Clock, type Day, type Weekday } from "./later-read.ts";
import { MINUTE } from "./timing.ts";

function offsetAt(zone: string, ms: number): number {
  return Date.parse(`${localMinute(ms, zone)}:00Z`) - Math.floor(ms / MINUTE) * MINUTE;
}

function instantIn(zone: string, date: string, clock: Clock): number {
  const wall = Date.parse(`${date}T${two(clock.hour)}:${two(clock.minute)}:00Z`);
  const real = [wall - offsetAt(zone, wall - DAY), wall - offsetAt(zone, wall + DAY)].filter(
    (at) => at + offsetAt(zone, at) === wall,
  );
  if (real.length === 0)
    throw new Error(
      `${two(clock.hour)}:${two(clock.minute)} does not exist in ${zone} on ${date}, because the clocks skip it. Say a time before or after it.`,
    );
  return Math.min(...real);
}

function civil(year: number, month: number, day: number, said: string): string {
  const date = `${String(year).padStart(4, "0")}-${two(month)}-${two(day)}`;
  const real = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(real.getTime()) || real.getUTCMonth() + 1 !== month || real.getUTCDate() !== day)
    throw new Error(`"${said}" is not a date that exists.`);
  return date;
}

function calendarDate(day: Extract<Day, { kind: "date" }>, today: string, said: string): string {
  const thisYear = Number(today.slice(0, 4));
  const date = civil(day.year ?? thisYear, day.month, day.day, said);
  return day.year === undefined && date < today
    ? civil(thisYear + 1, day.month, day.day, said)
    : date;
}

interface Reading {
  readonly said: string;
  readonly zone: string;
  readonly now: number;
  readonly clock: Clock | undefined;
  readonly day: Day | undefined;
  readonly weekday: Weekday | undefined;
}

function weekdayDate(reading: Reading, today: string): string {
  const { weekday, clock, now, zone } = reading;
  if (weekday === undefined) return today;
  const first = clock === undefined || weekday.next ? 1 : 0;
  for (let ahead = first; ahead <= 7; ahead += 1) {
    const date = shiftDays(today, ahead);
    if (weekdayOf(date) === weekday.name && instantIn(zone, date, clock ?? MORNING) > now)
      return date;
  }
  return today;
}

function dateOfReading(reading: Reading, today: string): string | undefined {
  const { day, said } = reading;
  if (day === undefined)
    return reading.weekday === undefined ? undefined : weekdayDate(reading, today);
  if (day.kind === "date") return calendarDate(day, today, said);
  return day.kind === "today" ? today : shiftDays(today, 1);
}

function requireWeekday(reading: Reading, date: string): void {
  const { weekday, day, said } = reading;
  if (weekday === undefined || day === undefined) return;
  if (day.kind !== "date") throw new Error(`"${said}" names two days. Say one.`);
  if (weekdayOf(date) !== weekday.name)
    throw new Error(`"${said}" names a weekday that is not that date.`);
}

function resolve(reading: Reading): number {
  const { zone, now, clock, said } = reading;
  const today = localMinute(now, zone).slice(0, 10);
  const date = dateOfReading(reading, today);
  const time = clock ?? MORNING;
  if (date === undefined) {
    const soonest = instantIn(zone, today, time);
    return soonest > now ? soonest : instantIn(zone, shiftDays(today, 1), time);
  }
  requireWeekday(reading, date);
  const until = instantIn(zone, date, time);
  if (until <= now) throw new Error(`"${said}" is already in the past. Say a later time.`);
  return until;
}

export function laterAt(said: string, now: number, zone: string): LaterResult {
  const problem = timeZoneProblem(zone);
  if (problem !== undefined) throw new Error(problem);
  const { ahead, zone: named, clock, date, day: dayWord, weekday } = scan(said);
  if (date !== undefined && dayWord !== undefined)
    throw new Error(`"${said}" names two days. Say one.`);
  const day = date ?? dayWord;
  const found = [clock, day, weekday].some((each) => each !== undefined);
  if (ahead !== undefined) {
    if (found) throw new Error(`"${said}" gives both a time ahead and a time of day. Say one.`);
    return { until: now + ahead, zone: named ?? zone };
  }
  if (!found) throw new Error(`No time in "${said}". Say when, such as ${LATER_EXAMPLES}.`);
  const used = named ?? zone;
  return { until: resolve({ said, zone: used, now, clock, day, weekday }), zone: used };
}
