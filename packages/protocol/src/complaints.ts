import Type, { type Static, type TSchema } from "typebox";

const MAX_COMPLAINT = 500;

const Nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);

const ComplaintSchema = Type.Object({
  id: Type.Integer(),
  at: Type.Integer(),
  session: Type.String(),
  role: Type.Enum(["mate", "worker"]),
  lane: Type.String(),
  card: Nullable(Type.Integer()),
  project: Nullable(Type.String()),
  text: Type.String(),
});
export type Complaint = Static<typeof ComplaintSchema>;

export const COMPLAINT_OPS = {
  complain: {
    roles: ["mate", "worker"],
    args: Type.Object({
      text: Type.String({
        pattern: "\\S",
        maxLength: MAX_COMPLAINT,
        description: `One concise sentence, at most ${String(MAX_COMPLAINT)} characters, with no credentials and no customer data`,
      }),
      card: Type.Optional(
        Type.Integer({
          description:
            "A mate only: the card number the complaint is about, such as the card you just closed. A worker's complaint always names its own card",
        }),
      ),
    }),
    result: Type.Object({ id: Type.Integer() }),
  },
  complaints: {
    roles: ["mate"],
    args: Type.Object({
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 200,
          description: "The most complaints to list, newest first (20)",
        }),
      ),
    }),
    result: Type.Array(ComplaintSchema),
  },
} as const;
