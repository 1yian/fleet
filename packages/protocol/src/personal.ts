import Type from "typebox";

export const PERSONAL_PROJECT = "personal";

export const PERSONAL_OPS = {
  "project.personal": {
    roles: ["mate"],
    args: Type.Object({
      host: Type.String({ minLength: 1 }),
      path: Type.String({ pattern: "^/" }),
    }),
    result: Type.Object({ project: Type.String(), path: Type.String() }),
  },
} as const;
