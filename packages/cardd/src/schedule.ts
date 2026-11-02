import { WAKE_DAYS, type Plan, type WakeDay } from "@fleet/protocol";

export interface Slot {
  readonly minute: string;
  readonly purpose: string;
}

const LOOKBACK_DAYS = 7;
const SUNDAY_FIRST: readonly WakeDay[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

export function timeZoneProblem(timeZone: string): string | undefined {
  try {
    new Intl.DateTimeFormat("en", { timeZone });
    return undefined;
  } catch {
    return `${timeZone} is not an IANA time zone, such as America/Chicago`;
  }
}

export function localMinute(ms: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(ms);
  const part = (type: string): string => parts.find((each) => each.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}`;
}

const dayStart = (date: string): Date => new Date(`${date}T00:00:00Z`);

function shiftDays(date: string, days: number): string {
  const shifted = dayStart(date);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

const weekdayOf = (date: string): WakeDay => SUNDAY_FIRST[dayStart(date).getUTCDay()] ?? "sun";

function latestSlot(at: string, days: readonly WakeDay[], nowMinute: string): string | undefined {
  const today = nowMinute.slice(0, 10);
  for (let back = 0; back <= LOOKBACK_DAYS; back += 1) {
    const date = shiftDays(today, -back);
    const minute = `${date}T${at}`;
    if (days.includes(weekdayOf(date)) && minute <= nowMinute) return minute;
  }
  return undefined;
}

export function dueSlots(plan: Plan, since: number, now: number): Slot[] {
  const nowMinute = localMinute(now, plan.timezone);
  const sinceMinute = localMinute(since, plan.timezone);
  return plan.wakes.flatMap(({ at, days, purpose }) => {
    const minute = latestSlot(at, days ?? WAKE_DAYS, nowMinute);
    return minute === undefined || minute < sinceMinute ? [] : [{ minute, purpose }];
  });
}
