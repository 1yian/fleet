import Type, { type Static } from "typebox";

export const LATER_EXAMPLES = "tomorrow, Friday 4PM, 4PM CST, Nov 20, or in 2 hours";

export const LaterFields = {
  said: Type.String({
    pattern: "\\S",
    description: `The captain's own words for when the decision returns to him, such as ${LATER_EXAMPLES}`,
  }),
  zone: Type.String({
    minLength: 1,
    description:
      "The IANA time zone of the screen he typed on, such as America/Chicago. A bare time or day is read in it, and a zone named in his words wins",
  }),
};

export const LaterResult = Type.Object({ until: Type.Integer(), zone: Type.String() });
export type LaterResult = Static<typeof LaterResult>;

export const ActedSchema = Type.Object({ later: Type.Optional(LaterResult) });

const stamp = (until: number, zone: string, year: boolean): string =>
  new Date(until).toLocaleString("en-US", {
    timeZone: zone,
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(year ? { year: "numeric" } : {}),
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });

const yearIn = (ms: number, zone: string): string =>
  new Date(ms).toLocaleString("en-US", { timeZone: zone, year: "numeric" });

export function laterLine(card: number, later: LaterResult, now: number): string {
  const { until, zone } = later;
  const when = stamp(until, zone, yearIn(until, zone) !== yearIn(now, zone));
  return `c-${String(card)} comes back to you ${when} (${zone})`;
}
