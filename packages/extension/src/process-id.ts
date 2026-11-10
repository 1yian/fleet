import { randomUUID } from "node:crypto";

const KEY = Symbol.for("fleet:process");

export function processId(): string {
  const found: unknown = Reflect.get(globalThis, KEY);
  if (typeof found === "string") return found;
  const created = randomUUID();
  Reflect.set(globalThis, KEY, created);
  return created;
}
