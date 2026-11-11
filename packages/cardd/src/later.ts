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

function civil(year: number, month: number, day: number): string | undefined {
  const date = `${String(year).padStart(4, "0")}-${two(month)}-${two(day)}`;
  const real = new Date(`${date}T00:00:00Z`);
  const exists =
    !Number.isNaN(real.getTime()) && real.getUTCMonth() + 1 === month && real.getUTCDate() === day;
  return exists ? date : undefined;
}

interface Reading {
  readonly said: string;
  readonly zone: string;
  readonly now: number;
  readonly clock: Clock | undefined;
  readonly day: Day | undefined;
  readonly weekday: Weekday | undefined;
}

const LEAP_SPAN = 8;

const noUpcoming = (said: string): Error =>
  new Error(`"${said}" is already in the past. Say a later time.`);

function firstUpcoming(reading: Reading, dates: readonly string[]): string | undefined {
  const { zone, now, clock } = reading;
  const time = clock ?? MORNING;
  const local = localMinute(now, zone);
  return dates.find(
    (date) =>
      `${date}T${two(time.hour)}:${two(time.minute)}` > local && instantIn(zone, date, time) > now,
  );
}

function calendarDate(
  day: Extract<Day, { kind: "date" }>,
  reading: Reading,
  today: string,
): string {
  const { said } = reading;
  const thisYear = Number(today.slice(0, 4));
  const years =
    day.year === undefined
      ? Array.from({ length: LEAP_SPAN + 1 }, (_, ahead) => thisYear + ahead)
      : [day.year];
  const dates = years
    .map((year) => civil(year, day.month, day.day))
    .filter((date) => date !== undefined);
  if (dates.length === 0) throw new Error(`"${said}" is not a date that exists.`);
  if (day.year !== undefined) return dates[0] ?? today;
  const found = firstUpcoming(reading, dates);
  if (found === undefined) throw noUpcoming(said);
  return found;
}

function weekdayDate(reading: Reading, weekday: Weekday, today: string): string {
  const first = reading.clock === undefined || weekday.next ? 1 : 0;
  const dates = Array.from({ length: 8 - first }, (_, at) => shiftDays(today, first + at)).filter(
    (date) => weekdayOf(date) === weekday.name,
  );
  const found = firstUpcoming(reading, dates);
  if (found === undefined) throw noUpcoming(reading.said);
  return found;
}

function dateOfReading(reading: Reading, today: string): string {
  const { day, weekday } = reading;
  if (day === undefined) {
    if (weekday !== undefined) return weekdayDate(reading, weekday, today);
    const found = firstUpcoming(reading, [today, shiftDays(today, 1)]);
    if (found === undefined) throw noUpcoming(reading.said);
    return found;
  }
  if (day.kind === "date") return calendarDate(day, reading, today);
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
  requireWeekday(reading, date);
  const until = instantIn(zone, date, clock ?? MORNING);
  if (until <= now) throw noUpcoming(said);
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
