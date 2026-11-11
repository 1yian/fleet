import Type, { type Static, type TSchema } from "typebox";
import Value from "typebox/value";

const Envelope = Type.Object({
  id: Type.Optional(Type.Integer()),
  method: Type.Optional(Type.String()),
  params: Type.Optional(Type.Unknown()),
  result: Type.Optional(Type.Unknown()),
  error: Type.Optional(Type.Unknown()),
  sessionId: Type.Optional(Type.String()),
});

export type Wire = Static<typeof Envelope>;

export function parseWire(text: string): Wire | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return Value.Check(Envelope, value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function shape<T extends TSchema>(schema: T, value: unknown): Static<T> | undefined {
  return Value.Check(schema, value) ? value : undefined;
}

export function record(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return Object.fromEntries(Object.entries(value));
}

export function words(value: Record<string, unknown> | undefined, key: string): string | undefined {
  const found = value?.[key];
  return typeof found === "string" ? found : undefined;
}
