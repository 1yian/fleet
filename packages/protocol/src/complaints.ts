import Type from "typebox";

const MAX_COMPLAINT = 500;

export const COMPLAINT_OPS = {
  "complaint.publish": {
    roles: ["mate", "worker"],
    args: Type.Object({
      text: Type.String({
        pattern: String.raw`^(?![\s\S]*\x00)\s*\S`,
        maxLength: MAX_COMPLAINT,
        description: `One concise sentence, at most ${String(MAX_COMPLAINT)} characters, with no credentials, no customer data, and nothing private: it becomes a public GitHub issue`,
      }),
      card: Type.Optional(
        Type.Integer({
          description:
            "A mate only: the card number the complaint is about, such as the card you just closed. A worker's complaint always names its own card",
        }),
      ),
    }),
    result: Type.Null(),
  },
} as const;
