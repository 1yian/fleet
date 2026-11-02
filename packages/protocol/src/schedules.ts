import Type, { type Static, type TSchema } from "typebox";
import { WakeArgsSchema } from "./wakes.ts";

export const MAX_SCHEDULES = 24;

const Nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);

const Fields = {
  to: Type.String({
    minLength: 1,
    description: "The lane that receives the message: main, or the name of a second mate",
  }),
  at: Type.String({
    pattern: "^([01][0-9]|2[0-3]):[0-5][0-9]$",
    description: "The local time of day, as HH:MM on a 24-hour clock",
  }),
  timezone: Type.String({
    minLength: 1,
    description: "An IANA time zone name, such as America/Chicago. The time is in it",
  }),
  on: Type.Optional(
    Type.String({
      pattern: "^\\d{4}-\\d{2}-\\d{2}$",
      description:
        "A local date, YYYY-MM-DD, for a message that is delivered once and then removed. Leave it out for a message that repeats every day",
    }),
  ),
  text: Type.String({
    pattern: "\\S",
    maxLength: 500,
    description: "The message, delivered word for word",
  }),
};

export const ScheduleSchema = Type.Object({
  id: Type.Integer(),
  owner: Type.String(),
  to: Type.String(),
  at: Type.String(),
  timezone: Type.String(),
  on: Nullable(Type.String()),
  text: Type.String(),
});
export type Schedule = Static<typeof ScheduleSchema>;

export const SCHEDULE_OPS = {
  wake: {
    roles: ["mate"],
    args: WakeArgsSchema,
    result: Type.Object({ entry: Type.Integer() }),
  },
  "schedule.set": {
    roles: ["mate"],
    args: Type.Object(
      {
        id: Type.Optional(
          Type.Integer({ description: "The schedule to change. Leave it out to make a new one" }),
        ),
        ...Fields,
      },
      { additionalProperties: false },
    ),
    result: ScheduleSchema,
  },
  "schedule.list": {
    roles: ["mate"],
    args: Type.Object({}),
    result: Type.Array(ScheduleSchema),
  },
  "schedule.remove": {
    roles: ["mate"],
    args: Type.Object({ id: Type.Integer() }),
    result: Type.Object({ id: Type.Integer() }),
  },
} as const;
