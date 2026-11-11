import { LATER_EXAMPLES, type WakeDay } from "@fleet/protocol";
import { timeZoneProblem } from "./schedule.ts";
import { MINUTE } from "./timing.ts";

const SECOND = 1000;
const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export const two = (n: number): string => String(n).padStart(2, "0");

export interface Clock {
  readonly hour: number;
  readonly minute: number;
}

export type Day =
  | { readonly kind: "today" | "tomorrow" }
  | { readonly kind: "date"; readonly month: number; readonly day: number; readonly year?: number };

export interface Weekday {
  readonly name: WakeDay;
  readonly next: boolean;
}

export const MORNING: Clock = { hour: 9, minute: 0 };

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
const UNITS = "sec|second|min|minute|hr|hour|day|wk|week";
const WORD = (alternatives: string): RegExp => new RegExp(`^(?:${alternatives})$`, "i");

const UNIT = WORD(`(?:${UNITS})s?`);
const QUANTITY = WORD("a|an|\\d{1,4}");
const GLUED = new RegExp(`^(?<count>\\d{1,4})(?<unit>(?:${UNITS})s?)$`, "i");
const MONTH_WORD = WORD(MONTH);
const MERIDIEM = /^(?<hour>\d{1,2})(?::(?<minute>\d{2}))?(?<half>[ap])m$/i;
const HOUR_ONLY = /^(?<hour>\d{1,2})(?::(?<minute>\d{2}))?$/;
const HALF_ONLY = /^(?<half>[ap])m$/i;
const TWENTY_FOUR = /^(?<hour>\d{1,2}):(?<minute>\d{2})$/;
const ISO_DATE = /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})$/;
const SLASH_DATE = /^(?<month>\d{1,2})\/(?<day>\d{1,2})(?:\/(?<year>\d{4}|\d{2}))?$/;
const DAY_WORD = /^(?<day>\d{1,2})(?:st|nd|rd|th)?$/i;
const YEAR = /^\d{4}$/;
const FIXED_OFFSET = /^(?:utc|gmt)?(?<sign>[+-])(?<hours>\d{1,2})(?::(?<minutes>\d{2}))?$/i;
const SLASH_ZONE = /^[A-Za-z]+(?:_[A-Za-z]+)*(?:\/[A-Za-z][^/]*)+$/;
const SIGNED = /^[+-][A-Za-z0-9]/;
const CAPITAL_OFFSET = /^[A-Z]{2,5}[+-]/;
const CAPITALS = /^[A-Z]{2,5}$/;
const UTC_WORD = /^(?:utc|gmt)/i;
const TIME_INFO = /[\d:/]/;
const CONNECTING = new Set([
  "at",
  "on",
  "by",
  "of",
  "in",
  "to",
  "the",
  "and",
  "or",
  "am",
  "pm",
  "next",
  "until",
  "for",
  "from",
  "this",
  "that",
  "with",
  "ok",
]);

interface Values {
  readonly ahead: number;
  readonly zone: string;
  readonly clock: Clock;
  readonly date: Day;
  readonly day: Day;
  readonly weekday: Weekday;
}

type Part = { [K in keyof Values]: { readonly kind: K; readonly value: Values[K] } }[keyof Values];

type Found = { -readonly [K in keyof Values]?: Values[K] };

interface Read {
  readonly used: number;
  readonly part: Part;
}

const WHAT: Readonly<Record<Exclude<Part["kind"], "ahead">, string>> = {
  clock: "times",
  date: "dates",
  day: "days",
  weekday: "weekdays",
  zone: "time zones",
};

const group = (found: RegExpExecArray, name: string): string => found.groups?.[name] ?? "";

const own = <T>(table: Readonly<Record<string, T>>, key: string): T | undefined =>
  Object.hasOwn(table, key) ? table[key] : undefined;

function tokensOf(said: string): string[] {
  return said
    .replace(/\b([ap])\.m\.?/gi, "$1m")
    .replace(/[,;!?()"“”]/g, " ")
    .replace(/\.(?!\d)/g, " ")
    .replace(/:(?!\d)/g, " ")
    .split(/\s+/)
    .filter((each) => each !== "");
}

const unknownZone = (token: string): string =>
  `${token} is not a time zone the reader knows. Use a city such as Europe/Paris, an offset such as UTC+2, or one of ET, CT, MT, PT.`;

const unreadable = (token: string): string =>
  `${token} is not a time, a date, or a time zone the reader knows. Say when, such as ${LATER_EXAMPLES}.`;

const moreThanOne = (said: string): string =>
  `"${said}" gives more than one amount of time. Say one amount, such as in 150 minutes.`;

function repeated(kind: Part["kind"], said: string): string {
  return kind === "ahead" ? moreThanOne(said) : `"${said}" names two ${WHAT[kind]}. Say one.`;
}

function amount(count: string): number {
  if (count === "a" || count === "an") return 1;
  return count === "half an" ? 0.5 : Number(count);
}

function lengthOf(count: string, unit: string): number {
  return Math.round(amount(count) * (own(UNIT_MS, unit.replace(/s$/, "")) ?? 0));
}

function quantityAt(
  tokens: readonly string[],
  at: number,
): { readonly used: number; readonly ms: number } | undefined {
  const first = (tokens[at] ?? "").toLowerCase();
  const second = (tokens[at + 1] ?? "").toLowerCase();
  const third = (tokens[at + 2] ?? "").toLowerCase();
  const glued = GLUED.exec(first);
  if (glued !== null) return { used: 1, ms: lengthOf(group(glued, "count"), group(glued, "unit")) };
  if (QUANTITY.test(first) && UNIT.test(second)) return { used: 2, ms: lengthOf(first, second) };
  if (first === "half" && second === "an" && UNIT.test(third))
    return { used: 3, ms: lengthOf("half an", third) };
  return undefined;
}

function durationAt(tokens: readonly string[], at: number, said: string): Read | undefined {
  if ((tokens[at] ?? "").toLowerCase() !== "in") return undefined;
  const quantity = quantityAt(tokens, at + 1);
  if (quantity === undefined) return undefined;
  if (quantity.ms <= 0) throw new Error(`"${said}" is no time ahead. Say a time in the future.`);
  return { used: 1 + quantity.used, part: { kind: "ahead", value: quantity.ms } };
}

function clockOf(hour: number, minute: number, shown: string): Clock {
  if (hour > 23 || minute > 59) throw new Error(`${shown} is not a time of day.`);
  return { hour, minute };
}

function meridiem(hour: string, minute: string, half: string, shown: string): Clock {
  if (Number(hour) < 1 || Number(hour) > 12) throw new Error(`${shown} is not a time of day.`);
  return clockOf((Number(hour) % 12) + (half === "p" ? 12 : 0), Number(minute), shown);
}

function clockAt(tokens: readonly string[], at: number): Read | undefined {
  const first = tokens[at] ?? "";
  const next = tokens[at + 1] ?? "";
  const read = (used: number, value: Clock): Read => ({ used, part: { kind: "clock", value } });
  const whole = MERIDIEM.exec(first);
  if (whole !== null)
    return read(
      1,
      meridiem(
        group(whole, "hour"),
        group(whole, "minute"),
        group(whole, "half").toLowerCase(),
        first,
      ),
    );
  const hours = HOUR_ONLY.exec(first);
  const half = HALF_ONLY.exec(next);
  if (hours !== null && half !== null)
    return read(
      2,
      meridiem(
        group(hours, "hour"),
        group(hours, "minute"),
        group(half, "half").toLowerCase(),
        `${first} ${next}`,
      ),
    );
  const day = TWENTY_FOUR.exec(first);
  if (day !== null)
    return read(1, clockOf(Number(group(day, "hour")), Number(group(day, "minute")), first));
  const word = first.toLowerCase();
  if (word === "noon" || word === "midnight")
    return read(1, { hour: word === "noon" ? 12 : 0, minute: 0 });
  return undefined;
}

function yearOf(text: string): number | undefined {
  if (text === "") return undefined;
  return text.length === 2 ? 2000 + Number(text) : Number(text);
}

function dayOf(month: number, day: string, year: string): Day {
  const known = yearOf(year);
  const date = { kind: "date" as const, month, day: Number(day) };
  return known === undefined ? date : { ...date, year: known };
}

function monthOf(name: string): number {
  return MONTHS.indexOf(name.toLowerCase().slice(0, 3)) + 1;
}

function numericDateAt(first: string): Read | undefined {
  const read = (value: Day): Read => ({ used: 1, part: { kind: "date", value } });
  const iso = ISO_DATE.exec(first);
  if (iso !== null)
    return read(dayOf(Number(group(iso, "month")), group(iso, "day"), group(iso, "year")));
  const slash = SLASH_DATE.exec(first);
  if (slash === null) return undefined;
  return read(dayOf(Number(group(slash, "month")), group(slash, "day"), group(slash, "year")));
}

function monthFirstAt(tokens: readonly string[], at: number): Read | undefined {
  const first = tokens[at] ?? "";
  const day = DAY_WORD.exec(tokens[at + 1] ?? "");
  const third = tokens[at + 2] ?? "";
  if (!MONTH_WORD.test(first) || day === null || HALF_ONLY.test(third)) return undefined;
  const year = YEAR.test(third) ? third : "";
  const value = dayOf(monthOf(first), group(day, "day"), year);
  return { used: year === "" ? 2 : 3, part: { kind: "date", value } };
}

function dayFirstAt(tokens: readonly string[], at: number): Read | undefined {
  const day = DAY_WORD.exec(tokens[at] ?? "");
  if (day === null) return undefined;
  const skip = (tokens[at + 1] ?? "").toLowerCase() === "of" ? 1 : 0;
  const name = tokens[at + 1 + skip] ?? "";
  if (!MONTH_WORD.test(name)) return undefined;
  const third = tokens[at + 2 + skip] ?? "";
  const year = YEAR.test(third) ? third : "";
  const value = dayOf(monthOf(name), group(day, "day"), year);
  return { used: (year === "" ? 2 : 3) + skip, part: { kind: "date", value } };
}

function dateAt(tokens: readonly string[], at: number): Read | undefined {
  return numericDateAt(tokens[at] ?? "") ?? monthFirstAt(tokens, at) ?? dayFirstAt(tokens, at);
}

function dayAt(tokens: readonly string[], at: number): Read | undefined {
  const word = (tokens[at] ?? "").toLowerCase();
  if (word === "tomorrow" || word === "today")
    return { used: 1, part: { kind: "day", value: { kind: word } } };
  const name = own(WEEKDAYS, word);
  if (name !== undefined)
    return { used: 1, part: { kind: "weekday", value: { name, next: false } } };
  const after = own(WEEKDAYS, (tokens[at + 1] ?? "").toLowerCase());
  if (word === "next" && after !== undefined)
    return { used: 2, part: { kind: "weekday", value: { name: after, next: true } } };
  return undefined;
}

function fixedOffset(found: RegExpExecArray): string | undefined {
  const minutes = Number(group(found, "minutes"));
  const total = Number(group(found, "hours")) * 60 + minutes;
  const signed = group(found, "sign") === "-" ? -total : total;
  if (minutes > 45 || minutes % 15 !== 0 || signed < -12 * 60 || signed > 14 * 60) return undefined;
  const sign = signed < 0 ? "-" : "+";
  return `${sign}${two(Math.trunc(Math.abs(signed) / 60))}:${two(Math.abs(signed) % 60)}`;
}

function zoneNamed(token: string): string | undefined {
  const known = own(ZONES, token.toLowerCase()) ?? own(CAPITAL_ZONES, token);
  if (known !== undefined) return known;
  const offset = FIXED_OFFSET.exec(token);
  if (offset !== null) return fixedOffset(offset);
  if (!SLASH_ZONE.test(token) || timeZoneProblem(token) !== undefined) return undefined;
  return new Intl.DateTimeFormat("en", { timeZone: token }).resolvedOptions().timeZone;
}

function zoneLike(token: string, positioned: boolean): boolean {
  const word = token.toLowerCase();
  return (
    own(ZONES, word) !== undefined ||
    own(CAPITAL_ZONES, token) !== undefined ||
    UTC_WORD.test(token) ||
    SIGNED.test(token) ||
    CAPITAL_OFFSET.test(token) ||
    SLASH_ZONE.test(token) ||
    (positioned && CAPITALS.test(token) && !CONNECTING.has(word) && !MONTH_WORD.test(token))
  );
}

function zoneAt(token: string, positioned: boolean): Read | undefined {
  if (!zoneLike(token, positioned)) return undefined;
  const zone = zoneNamed(token);
  if (zone === undefined) throw new Error(unknownZone(token));
  return { used: 1, part: { kind: "zone", value: zone } };
}

function readAt(
  tokens: readonly string[],
  at: number,
  said: string,
  positioned: boolean,
): Read | undefined {
  return (
    durationAt(tokens, at, said) ??
    clockAt(tokens, at) ??
    dateAt(tokens, at) ??
    dayAt(tokens, at) ??
    zoneAt(tokens[at] ?? "", positioned)
  );
}

function claim(found: Found, part: Part, said: string): void {
  if (found[part.kind] !== undefined) throw new Error(repeated(part.kind, said));
  switch (part.kind) {
    case "ahead":
      found.ahead = part.value;
      break;
    case "zone":
      found.zone = part.value;
      break;
    case "clock":
      found.clock = part.value;
      break;
    case "date":
      found.date = part.value;
      break;
    case "day":
      found.day = part.value;
      break;
    case "weekday":
      found.weekday = part.value;
      break;
  }
}

function passed(token: string, positioned: boolean): boolean {
  if (TIME_INFO.test(token)) throw new Error(unreadable(token));
  return positioned && (CONNECTING.has(token.toLowerCase()) || MONTH_WORD.test(token));
}

export function scan(said: string): Found {
  const tokens = tokensOf(said);
  const found: Found = {};
  let positioned = false;
  let at = 0;
  while (at < tokens.length) {
    const token = tokens[at] ?? "";
    if (
      found.ahead !== undefined &&
      (quantityAt(tokens, at) !== undefined || token.toLowerCase() === "half")
    )
      throw new Error(moreThanOne(said));
    const read: Read | undefined = readAt(tokens, at, said, positioned);
    if (read === undefined) {
      positioned = passed(token, positioned);
      at += 1;
    } else {
      claim(found, read.part, said);
      positioned = read.part.kind !== "zone";
      at += read.used;
    }
  }
  return found;
}
