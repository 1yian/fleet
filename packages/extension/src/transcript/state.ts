import type { Theme } from "@earendil-works/pi-coding-agent";

const KEY = Symbol.for("fleet:transcript-state");

export interface TranscriptState {
  mate: string;
  theme: (() => Theme) | undefined;
}

function isState(value: unknown): value is TranscriptState {
  return typeof value === "object" && value !== null && "mate" in value && "theme" in value;
}

export function transcriptState(): TranscriptState {
  const found: unknown = Reflect.get(globalThis, KEY);
  if (isState(found)) return found;
  const created: TranscriptState = { mate: "mate", theme: undefined };
  Reflect.set(globalThis, KEY, created);
  return created;
}
