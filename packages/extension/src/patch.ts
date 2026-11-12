export function once(name: string, install: () => void): void {
  const key = Symbol.for(`fleet:patch:${name}`);
  if (Reflect.get(globalThis, key) === true) return;
  Reflect.set(globalThis, key, true);
  install();
}

export function methodOf(
  proto: object,
  member: string,
): (self: object, ...args: unknown[]) => unknown {
  const method: unknown = Reflect.get(proto, member);
  if (typeof method !== "function") throw new Error(`Fleet requires Pi ${member}()`);
  return (self, ...args) => {
    const result: unknown = Reflect.apply(method, self, args);
    return result;
  };
}

function lines(value: unknown): string[] {
  if (Array.isArray(value) && value.every((line) => typeof line === "string")) return value;
  throw new Error("Pi's render did not return lines");
}

export function patchRender(
  proto: object,
  name: string,
  draw: (row: object, width: number, drawn: () => string[]) => string[],
): void {
  once(name, () => {
    const original = methodOf(proto, "render");
    Reflect.set(proto, "render", function (this: object, width: number): string[] {
      return draw(this, width, () => lines(original(this, width)));
    });
  });
}

export function installPresentation(feature: string, name: string, patch: () => void): void {
  try {
    patch();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`Fleet ${feature}: the ${name} presentation is unavailable, skipping. ${reason}`);
  }
}
