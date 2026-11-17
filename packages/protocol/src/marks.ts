import Type, { type TSchema } from "typebox";

export const CAPTAIN_LOG_NAME = "captain-log";

const Nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);

export const PresentedCardSchema = Type.Object({
  card: Type.Integer({
    description: "The card whose decision your chat message to the captain in this turn brings up",
  }),
});

export const MARK_OPS = {
  "captain.seen": {
    roles: ["mate"],
    args: Type.Object({
      away: Type.Optional(
        Type.Boolean({
          description:
            "True when the captain's message said afk: it is recorded as away, not as seen",
        }),
      ),
    }),
    result: Type.Object({ entry: Type.Integer() }),
  },
  presented: {
    roles: ["mate"],
    args: Type.Object({
      ...PresentedCardSchema.properties,
      occurrence: Type.Integer({
        description:
          "The hold occurrence that was checked as waiting on the captain. Refused when the card's hold has since been replaced by another occurrence",
      }),
    }),
    result: Type.Object({ card: Type.Integer(), waiting: Type.Integer() }),
  },
  walkthrough: {
    roles: ["mate"],
    args: Type.Object({
      paused: Type.Boolean({
        description:
          "True when the captain paused or stopped the decision walkthrough, false only when he asked to resume it",
      }),
    }),
    result: Type.Object({ paused: Type.Boolean() }),
  },
  "decision.due": {
    roles: ["mate"],
    args: Type.Object({}),
    result: Nullable(
      Type.Object({
        card: Type.Integer(),
        title: Type.String(),
        question: Type.String(),
        waiting: Type.Integer(),
      }),
    ),
  },
} as const;
