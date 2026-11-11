import Type from "typebox";

export const PROJECT_OPS = {
  "project.yolo": {
    roles: ["mate"],
    args: Type.Object({ project: Type.String({ minLength: 1 }), on: Type.Boolean() }),
    result: Type.Object({ project: Type.String(), on: Type.Boolean() }),
  },
  projects: {
    roles: ["mate"],
    args: Type.Object({}),
    result: Type.Array(
      Type.Object({
        name: Type.String(),
        delivery: Type.String(),
        base: Type.String(),
        clones: Type.Array(Type.Object({ host: Type.String(), path: Type.String() })),
        yolo: Type.Boolean(),
      }),
    ),
  },
} as const;
