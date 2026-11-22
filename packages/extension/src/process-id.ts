import { randomUUID } from "node:crypto";

const KEY = Symbol.for("fleet:process");

export const PROCESS_ARG = "--fleet-process=";

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

export function processId(): string {
  const found: unknown = Reflect.get(globalThis, KEY);
  if (typeof found === "string") return found;
  const given = process.argv.find((arg) => arg.startsWith(PROCESS_ARG))?.slice(PROCESS_ARG.length);
  const created = given !== undefined && UUID.test(given) ? given : randomUUID();
  Reflect.set(globalThis, KEY, created);
  return created;
}
