import { readFileSync } from "node:fs";

const file = process.env["FLEET_E2E_CLOCK"];

if (file !== undefined) {
  const REREAD_MS = 50;
  let skew = 0;
  let checked = Number.NEGATIVE_INFINITY;
  const current = (): number => {
    const at = performance.now();
    if (at - checked >= REREAD_MS) {
      checked = at;
      try {
        skew = Number(readFileSync(file, "utf8")) || 0;
      } catch {
        return skew;
      }
    }
    return skew;
  };
  const epoch = process.env["FLEET_E2E_CLOCK_EPOCH"];
  const now = Date.now.bind(Date);
  const time = (): number => (epoch === undefined ? now() : Number(epoch)) + current();
  globalThis.Date = new Proxy(Date, {
    construct: (target, args: unknown[], newTarget): object => {
      const made: unknown = Reflect.construct(
        target,
        args.length === 0 ? [time()] : args,
        newTarget,
      );
      if (typeof made !== "object" || made === null) throw new TypeError("Date did not construct");
      return made;
    },
    get: (target, key): unknown => {
      if (key === "now") return time;
      const value: unknown = Reflect.get(target, key);
      return value;
    },
  });
}
