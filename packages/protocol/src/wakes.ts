import Type, { type Static } from "typebox";

export function howToAnswerWake(card: number, id: string): string {
  return `answer with comment(card=${String(card)}, text, replyTo="${id}")`;
}

export const WAKE_DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type WakeDay = (typeof WAKE_DAYS)[number];

const WakeSchema = Type.Object(
  {
    at: Type.String({
      pattern: "^([01][0-9]|2[0-3]):[0-5][0-9]$",
      description: "The local time of day in the plan's time zone, as HH:MM on a 24-hour clock",
    }),
    days: Type.Optional(
      Type.Array(Type.Enum(WAKE_DAYS), {
        minItems: 1,
        uniqueItems: true,
        description: "The days of the week it applies to. Leave it out for every day",
      }),
    ),
    purpose: Type.String({
      pattern: "^[^\\r\\n]*\\S[^\\r\\n]*$",
      maxLength: 120,
      description: "What the wake is for, in one short line",
    }),
  },
  { additionalProperties: false },
);

export const PlanSchema = Type.Object(
  {
    goal: Type.String({
      description:
        "The lane's goal and standing instructions, with any limits (such as an allowance) written as text",
    }),
    timezone: Type.String({
      minLength: 1,
      description: "An IANA time zone name, such as America/Chicago. Every wake time is in it",
    }),
    wakes: Type.Array(WakeSchema, { maxItems: 24 }),
  },
  { additionalProperties: false },
);
export type Plan = Static<typeof PlanSchema>;

export const WakeArgsSchema = Type.Object({
  note: Type.String({
    pattern: "\\S",
    maxLength: 500,
    description: "What woke the mate, in a few words",
  }),
  script: Type.Optional(
    Type.String({
      pattern: "^[A-Za-z0-9._-]+$",
      maxLength: 40,
      description: "The name of the script that wakes the mate, such as guard",
    }),
  ),
});
