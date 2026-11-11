import { LATER_EXAMPLES, type LaterResult, type WakeDay } from "@fleet/protocol";
import { localMinute, shiftDays, timeZoneProblem, weekdayOf } from "./schedule.ts";
import { MINUTE } from "./timing.ts";

const SECOND = 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const two = (n: number): string => String(n).padStart(2, "0");

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
  cet: "Europe/Paris",
  cest: "Europe/Paris",
  eet: "Europe/Athens",
  eest: "Europe/Athens",
  bst: "Europe/London",
  jst: "Asia/Tokyo",
  kst: "Asia/Seoul",
  aest: "Australia/Sydney",
  aedt: "Australia/Sydney",
  nzst: "Pacific/Auckland",
  nzdt: "Pacific/Auckland",
};

const CAPITAL_ZONES: Readonly<Record<string, string>> = {
  WET: "Europe/Lisbon",
  WEST: "Europe/Lisbon",
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
const SEGMENT = "[a-z]+(?:[_-][a-z]+)*(?:[+-]\\d{1,2})?";
const UNITS = "sec|second|min|minute|hr|hour|day|wk|week";
const COUNT = "a|an|half an|\\d{1,4}";
const OFFSET = "[+-]\\s*\\d{1,2}(?::\\d+)?";
const AFTER_TIME = "(?<=(?:\\d:\\d{2}|[ap]m|noon|midnight)\\s*)";

const RELATIVE = new RegExp(`\\bin\\s+(?<count>${COUNT})\\s*(?<unit>(?:${UNITS})s?)\\b`, "i");
const ANOTHER_AMOUNT = new RegExp(
  `\\b(?:(?:a|an|half an)\\s+|\\d{1,4}\\s*)(?:${UNITS})s?\\b|\\bhalf\\b`,
  "i",
);
const ZONE = new RegExp(
  `\\b(?:(?:${AREA})(?:/${SEGMENT}){1,2}|(?:utc|gmt)\\s*${OFFSET}|(?-i:${Object.keys(CAPITAL_ZONES).join("|")})|${Object.keys(ZONES).join("|")})\\b|${AFTER_TIME}[+-]\\d{1,2}:\\d{2}\\b`,
  "i",
);
const FIXED_OFFSET = /^(?:utc|gmt)?\s*(?<sign>[+-])\s*(?<hours>\d{1,2})(?::(?<minutes>\d{2}))?$/i;
const SHOUTED_ZONE = /^\s*(?<token>[A-Z]{2,5})(?![A-Za-z0-9])/;
const MERIDIEM = /\b(?<hour>\d{1,2})(?::(?<minute>\d{2}))?\s*(?<half>[ap])m\b/i;
const TWENTY_FOUR = /\b(?<hour>\d{1,2}):(?<minute>\d{2})\b/i;
const NOON = /\b(?<word>noon|midnight)\b/i;
const ISO_DATE = /\b(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})\b/i;
const SLASH_DATE = /\b(?<month>\d{1,2})\/(?<day>\d{1,2})(?:\/(?<year>\d{4}|\d{2}))?\b/i;
const MONTH_FIRST = new RegExp(
  `\\b(?<name>${MONTH})\\s+(?<day>\\d{1,2})(?:st|nd|rd|th)?\\b(?:\\s+(?<year>\\d{4})\\b)?`,
  "i",
);
const DAY_FIRST = new RegExp(
  `\\b(?<day>\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(?<name>${MONTH})\\b(?:\\s+(?<year>\\d{4})\\b)?`,
  "i",
);
const WEEKDAY = new RegExp(
  `\\b(?<next>next\\s+)?(?<name>${Object.keys(WEEKDAYS).join("|")})\\b`,
  "i",
);
const TOMORROW = /\btomorrow\b/i;
const TODAY = /\btoday\b/i;

const group = (found: RegExpExecArray, name: string): string =>
  (found.groups?.[name] ?? "").toLowerCase();

class Rest {
  private text: string;
  private readonly said: string;
  private readonly ends: number[] = [];

  constructor(said: string) {
    this.said = said;
    this.text = said
      .replace(/\b([ap])\.m\.?/gi, "$1m")
      .replace(/[,;!?()"“”]/g, " ")
      .replace(/\.(?!\d)/g, " ");
  }

  take(pattern: RegExp, what: string): RegExpExecArray | undefined {
    const found = pattern.exec(this.text);
    if (found === null) return undefined;
    const end = found.index + found[0].length;
    this.text = `${this.text.slice(0, found.index)}${" ".repeat(found[0].length)}${this.text.slice(end)}`;
    this.ends.push(end);
    if (pattern.test(this.text)) throw new Error(`"${this.said}" names two ${what}. Say one.`);
    return found;
  }

  holds(pattern: RegExp): boolean {
    return pattern.test(this.text);
  }

  shoutedZone(): string | undefined {
    for (const end of this.ends) {
      const token = SHOUTED_ZONE.exec(this.text.slice(end))?.groups?.["token"];
      if (token !== undefined) return token;
    }
    return undefined;
  }
}

function amount(count: string): number {
  if (count === "a" || count === "an") return 1;
  return count === "half an" ? 0.5 : Number(count);
}

function span(rest: Rest, said: string): number | undefined {
  const found = rest.take(RELATIVE, "durations");
  if (found === undefined) return undefined;
  if (rest.holds(ANOTHER_AMOUNT))
    throw new Error(
      `"${said}" gives more than one amount of time. Say one amount, such as in 150 minutes.`,
    );
  const unit = group(found, "unit").replace(/s$/, "");
  const ms = Math.round(amount(group(found, "count")) * (UNIT_MS[unit] ?? 0));
  if (ms <= 0) throw new Error(`"${said}" is no time ahead. Say a time in the future.`);
  return ms;
}

const unknownZone = (token: string): string =>
  `${token} is not a time zone the reader knows. Use a city such as Europe/Paris, an offset such as UTC+2, or one of ET, CT, MT, PT.`;

function fixedOffset(found: RegExpExecArray): string | undefined {
  const minutes = Number(group(found, "minutes"));
  const total = Number(group(found, "hours")) * 60 + minutes;
  const signed = group(found, "sign") === "-" ? -total : total;
  if (minutes > 45 || minutes % 15 !== 0 || signed < -12 * 60 || signed > 14 * 60) return undefined;
  const sign = signed < 0 ? "-" : "+";
  return `${sign}${two(Math.trunc(Math.abs(signed) / 60))}:${two(Math.abs(signed) % 60)}`;
}

function zoneNamed(token: string): string | undefined {
  const known = ZONES[token.toLowerCase()] ?? CAPITAL_ZONES[token];
  if (known !== undefined) return known;
  const offset = FIXED_OFFSET.exec(token);
  if (offset !== null) return fixedOffset(offset);
  if (timeZoneProblem(token) !== undefined) return undefined;
  return new Intl.DateTimeFormat("en", { timeZone: token }).resolvedOptions().timeZone;
}

function zoneIn(rest: Rest): string | undefined {
  const found = rest.take(ZONE, "time zones");
  if (found === undefined) return undefined;
  const zone = zoneNamed(found[0]);
  if (zone === undefined) throw new Error(unknownZone(found[0]));
  return zone;
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
  const shouted = rest.shoutedZone();
  if (shouted !== undefined) throw new Error(unknownZone(shouted));
  const used = named ?? zone;
  return { until: resolve({ said, zone: used, now, clock, day, weekday }), zone: used };
}
