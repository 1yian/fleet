import Type from "typebox";

const SIGNIN_URL = Type.String({
  minLength: 1,
  maxLength: 2048,
  description: "The exact HTTPS sign-in page URL, with no embedded credentials",
});

export const SigninGrantAction = Type.Object({
  kind: Type.Literal("signin-grant"),
  entry: Type.Integer({
    minimum: 1,
    description: "The id of the entry on this card that holds the password",
  }),
  lane: Type.String({
    minLength: 1,
    description: "The one lane whose worker may redeem the grant",
  }),
  url: SIGNIN_URL,
  username: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  span: Type.Optional(
    Type.Object(
      {
        start: Type.Integer({
          minimum: 0,
          description:
            "First Unicode code point of the password in the entry body, counting code points from 0",
        }),
        end: Type.Integer({
          minimum: 1,
          description:
            "Code point position after the last code point of the password",
        }),
      },
      {
        description:
          "The exact part of the entry body that is the password. Without it, the whole body must be the password",
      },
    ),
  ),
});

export const SIGNIN_OPS = {
  "signin.redeem": {
    roles: ["worker"],
    args: Type.Object({
      grant: Type.String({
        pattern: "^sg-[0-9a-f]{16}$",
        description:
          "The sign-in grant reference from the captain's card comment",
      }),
      entry: Type.Integer({
        minimum: 1,
        description: "The card entry the captain named for the grant",
      }),
      url: SIGNIN_URL,
    }),
    result: Type.Object({
      lane: Type.String(),
      origin: Type.String(),
      url: Type.String(),
      username: Type.Optional(Type.String()),
      password: Type.String({ minLength: 1 }),
    }),
  },
} as const;
