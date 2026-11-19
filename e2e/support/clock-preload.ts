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
  globalThis.Date = new Proxy(Date, {
    construct: (target, args, newTarget) =>
      Reflect.construct(target, args.length === 0 ? [target.now() + current()] : args, newTarget),
    get: (target, key) =>
      key === "now" ? () => target.now() + current() : Reflect.get(target, key),
  });
}
