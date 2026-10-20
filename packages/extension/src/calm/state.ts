// Whether Calm is on. The presentation patches live on Pi's component prototypes for
// the life of the process, and a Pi reload evaluates this module again, so the flag
// sits in one process-wide object that every evaluation shares.
const KEY = Symbol.for("fleet:calm-state");

interface CalmState {
  active: boolean;
}

function isState(value: unknown): value is CalmState {
  return typeof value === "object" && value !== null && "active" in value;
}

function shared(): CalmState {
  const found: unknown = Reflect.get(globalThis, KEY);
  if (isState(found)) return found;
  const created = { active: false };
  Reflect.set(globalThis, KEY, created);
  return created;
}

export const calmActive = (): boolean => shared().active;

export function setCalmActive(active: boolean): void {
  shared().active = active;
}
