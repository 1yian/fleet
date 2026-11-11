import { LATER_EXAMPLES, type LaterResult, type WakeDay } from "@fleet/protocol";
import { localMinute, shiftDays, timeZoneProblem, weekdayOf } from "./schedule.ts";
import { MINUTE } from "./timing.ts";

const SECOND = 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

interface Clock {
  readonly hour: number;
  readonly minute: number;
}

type Day =
  | { readonly kind: "today" | "tomorrow" }
  | { readonly kind: "date"; readonly month: number; readonly day: number; readonly year?: number };

interface Weekday {
  readonly name: WakeDay;
  readonly next: boolean;
}

const MORNING: Clock = { hour: 9, minute: 0 };

const UNIT_MS: Readonly<Record<string, number>> = {
  sec: SECOND,
  second: SECOND,
  min: MINUTE,
  minute: MINUTE,
  hr: HOUR,
  hour: HOUR,
  day: DAY,
  wk: 7 * DAY,
  week: 7 * DAY,
};

const ZONES: Readonly<Record<string, string>> = {
  est: "America/New_York",
  edt: "America/New_York",
  et: "America/New_York",
  cst: "America/Chicago",
  cdt: "America/Chicago",
  ct: "America/Chicago",
  mst: "America/Denver",
  mdt: "America/Denver",
  mt: "America/Denver",
  pst: "America/Los_Angeles",
  pdt: "America/Los_Angeles",
  pt: "America/Los_Angeles",
  akst: "America/Anchorage",
  akdt: "America/Anchorage",
  hst: "Pacific/Honolulu",
  utc: "UTC",
  gmt: "UTC",
};

const WEEKDAYS: Readonly<Record<string, WakeDay>> = {
  mon: "mon",
  monday: "mon",
  tue: "tue",
  tues: "tue",
  tuesday: "tue",
  wed: "wed",
  wednesday: "wed",
  thu: "thu",
  thur: "thu",
  thurs: "thu",
  thursday: "thu",
  fri: "fri",
  friday: "fri",
  sat: "sat",
  saturday: "sat",
  sun: "sun",
  sunday: "sun",
};

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH =
  "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
const AREA = "america|europe|asia|africa|australia|pacific|atlantic|indian|antarctica|arctic|etc";
const SEGMENT = "[a-z]+(?:[_-][a-z]+)*";

const RELATIVE = new RegExp(
  `\\bin\\s+(?<count>a|an|half an|\\d{1,4})\\s*(?<unit>(?:sec|second|min|minute|hr|hour|day|wk|week)s?)\\b`,
);
const ZONE = new RegExp(
  `\\b(?:(?:${AREA})(?:/${SEGMENT}){1,2}|${Object.keys(ZONES).join("|")})\\b`,
);
const MERIDIEM = /\b(?<hour>\d{1,2})(?::(?<minute>\d{2}))?\s*(?<half>[ap])m\b/;
const TWENTY_FOUR = /\b(?<hour>\d{1,2}):(?<minute>\d{2})\b/;
const NOON = /\b(?<word>noon|midnight)\b/;
const ISO_DATE = /\b(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})\b/;
const SLASH_DATE = /\b(?<month>\d{1,2})\/(?<day>\d{1,2})(?:\/(?<year>\d{4}|\d{2}))?\b/;
const MONTH_FIRST = new RegExp(
  `\\b(?<name>${MONTH})\\s+(?<day>\\d{1,2})(?:st|nd|rd|th)?\\b(?:\\s+(?<year>\\d{4})\\b)?`,
);
const DAY_FIRST = new RegExp(
  `\\b(?<day>\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(?<name>${MONTH})\\b(?:\\s+(?<year>\\d{4})\\b)?`,
);
const WEEKDAY = new RegExp(`\\b(?<next>next\\s+)?(?<name>${Object.keys(WEEKDAYS).join("|")})\\b`);
const TOMORROW = /\btomorrow\b/;
const TODAY = /\btoday\b/;

const group = (found: RegExpExecArray, name: string): string => found.groups?.[name] ?? "";

class Rest {
  private text: string;
  private readonly said: string;

  constructor(said: string) {
    this.said = said;
    this.text = said
      .toLowerCase()
      .replace(/\b([ap])\.m\.?/g, "$1m")
      .replace(/[,;!?()"“”]/g, " ")
      .replace(/\.(?!\d)/g, " ");
  }

  take(pattern: RegExp, what: string): RegExpExecArray | undefined {
    const found = pattern.exec(this.text);
    if (found === null) return undefined;
    const end = found.index + found[0].length;
    this.text = `${this.text.slice(0, found.index)}${" ".repeat(found[0].length)}${this.text.slice(end)}`;
    if (pattern.test(this.text)) throw new Error(`"${this.said}" names two ${what}. Say one.`);
    return found;
  }
}

function amount(count: string): number {
  if (count === "a" || count === "an") return 1;
  return count === "half an" ? 0.5 : Number(count);
}

function span(rest: Rest, said: string): number | undefined {
  const found = rest.take(RELATIVE, "durations");
  if (found === undefined) return undefined;
  const unit = group(found, "unit").replace(/s$/, "");
  const ms = Math.round(amount(group(found, "count")) * (UNIT_MS[unit] ?? 0));
  if (ms <= 0) throw new Error(`"${said}" is no time ahead. Say a time in the future.`);
  return ms;
}

function zoneIn(rest: Rest): string | undefined {
  const found = rest.take(ZONE, "time zones");
  if (found === undefined) return undefined;
  const zone = ZONES[found[0]] ?? found[0];
  const problem = timeZoneProblem(zone);
  if (problem !== undefined) throw new Error(problem);
  return new Intl.DateTimeFormat("en", { timeZone: zone }).resolvedOptions().timeZone;
}

function clockOf(hour: number, minute: number, shown: string): Clock {
  if (hour > 23 || minute > 59) throw new Error(`${shown} is not a time of day.`);
  return { hour, minute };
}

function meridiem(rest: Rest): Clock | undefined {
  const found = rest.take(MERIDIEM, "times");
  if (found === undefined) return undefined;
  const hour = Number(group(found, "hour"));
  if (hour < 1 || hour > 12) throw new Error(`${found[0]} is not a time of day.`);
  const pm = group(found, "half") === "p";
  return clockOf((hour % 12) + (pm ? 12 : 0), Number(group(found, "minute")), found[0]);
}

function twentyFour(rest: Rest): Clock | undefined {
  const found = rest.take(TWENTY_FOUR, "times");
  if (found === undefined) return undefined;
  return clockOf(Number(group(found, "hour")), Number(group(found, "minute")), found[0]);
}

function noon(rest: Rest): Clock | undefined {
  const found = rest.take(NOON, "times");
  if (found === undefined) return undefined;
  return { hour: group(found, "word") === "noon" ? 12 : 0, minute: 0 };
}

function clockIn(rest: Rest, said: string): Clock | undefined {
  const clocks = [meridiem(rest), twentyFour(rest), noon(rest)].filter(
    (each) => each !== undefined,
  );
  if (clocks.length > 1) throw new Error(`"${said}" names two times. Say one.`);
  return clocks[0];
}

function yearOf(text: string): number | undefined {
  if (text === "") return undefined;
  return text.length === 2 ? 2000 + Number(text) : Number(text);
}

function dateOf(found: RegExpExecArray, month: number): Day {
  const year = yearOf(group(found, "year"));
  const date = { kind: "date" as const, month, day: Number(group(found, "day")) };
  return year === undefined ? date : { ...date, year };
}

function monthOf(found: RegExpExecArray): number {
  return MONTHS.indexOf(group(found, "name").slice(0, 3)) + 1;
}

function calendarIn(rest: Rest, said: string): Day | undefined {
  const iso = rest.take(ISO_DATE, "dates");
  const slash = rest.take(SLASH_DATE, "dates");
  const first = rest.take(MONTH_FIRST, "dates");
  const last = rest.take(DAY_FIRST, "dates");
  const days = [
    iso && dateOf(iso, Number(group(iso, "month"))),
    slash && dateOf(slash, Number(group(slash, "month"))),
    first && dateOf(first, monthOf(first)),
    last && dateOf(last, monthOf(last)),
  ].filter((each) => each !== undefined);
  if (days.length > 1) throw new Error(`"${said}" names two dates. Say one.`);
  return days[0];
}

function weekdayIn(rest: Rest): Weekday | undefined {
  const found = rest.take(WEEKDAY, "weekdays");
  const name = found === undefined ? undefined : WEEKDAYS[group(found, "name")];
  return found === undefined || name === undefined
    ? undefined
    : { name, next: group(found, "next") !== "" };
}

function dayIn(rest: Rest, said: string): Day | undefined {
  const named = [
    calendarIn(rest, said),
    rest.take(TOMORROW, "days") && ({ kind: "tomorrow" } as const),
    rest.take(TODAY, "days") && ({ kind: "today" } as const),
  ].filter((each) => each !== undefined);
  if (named.length > 1) throw new Error(`"${said}" names two days. Say one.`);
  return named[0];
}

const two = (n: number): string => String(n).padStart(2, "0");

function offsetAt(zone: string, ms: number): number {
  return Date.parse(`${localMinute(ms, zone)}:00Z`) - Math.floor(ms / MINUTE) * MINUTE;
}

function instantIn(zone: string, date: string, clock: Clock): number {
  const wall = Date.parse(`${date}T${two(clock.hour)}:${two(clock.minute)}:00Z`);
  return wall - offsetAt(zone, wall - offsetAt(zone, wall));
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
  const rest = new Rest(said);
  const ahead = span(rest, said);
  const named = zoneIn(rest);
  const clock = clockIn(rest, said);
  const day = dayIn(rest, said);
  const weekday = weekdayIn(rest);
  const found = [clock, day, weekday].some((each) => each !== undefined);
  if (ahead !== undefined) {
    if (found) throw new Error(`"${said}" gives both a time ahead and a time of day. Say one.`);
    return { until: now + ahead, zone: named ?? zone };
  }
  if (!found) throw new Error(`No time in "${said}". Say when, such as ${LATER_EXAMPLES}.`);
  const used = named ?? zone;
  return { until: resolve({ said, zone: used, now, clock, day, weekday }), zone: used };
}
