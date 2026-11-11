import Type, { type Static } from "typebox";

export const NextSchema = Type.Object({
  build: Type.Optional(
    Type.Integer({
      description:
        "The number of a ship card that carries the build, open or Done. For when the captain already asked for the thing built",
    }),
  ),
  decision: Type.Optional(
    Type.Integer({
      description:
        "The number of an open card that holds the decision for the captain: a hold on it that waits on him, or a captain-only card. For when he asked only for a plan",
    }),
  ),
  drop: Type.Optional(
    Type.String({
      pattern: "\\S",
      description: "Why nothing is built, in one sentence. For when the findings make it moot",
    }),
  ),
});
export type Next = Static<typeof NextSchema>;
