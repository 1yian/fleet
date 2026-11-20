import Type from "typebox";

export const PERSONAL_PROJECT = "personal";

export const PERSONAL_OPS = {
  "project.personal": {
    roles: ["mate"],
    args: Type.Object({ host: Type.String({ minLength: 1 }) }),
    result: Type.Boolean(),
  },
} as const;
