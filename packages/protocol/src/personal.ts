import Type from "typebox";

export const PERSONAL_PROJECT = "personal";

export function missingPersonalClone(host: string, clones: readonly { host: string }[]): Error {
  const hosts = clones.map((clone) => clone.host).join(", ");
  return new Error(
    `project ${PERSONAL_PROJECT} is registered but has no clone on ${host}. Registered clone hosts: ${hosts || "none"}. Use a listed host or another registered project with a clone there; an administrator can add a clone`,
  );
}

export const PERSONAL_OPS = {
  "project.personal": {
    roles: ["mate"],
    args: Type.Object({ host: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
    result: Type.Boolean(),
  },
} as const;
