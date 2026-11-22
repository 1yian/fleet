const KEY = Symbol.for("fleet:discord-bridge-state");

export interface Outgoing {
  readonly parts: string[];
  readonly files: string[];
}

export interface BridgeState {
  announced: boolean;
  botId: string | undefined;
  cursor: string | undefined;
  draining: boolean;
  readonly queue: Outgoing[];
}

function isState(value: unknown): value is BridgeState {
  return typeof value === "object" && value !== null && "queue" in value && "announced" in value;
}

export function bridgeState(): BridgeState {
  const found: unknown = Reflect.get(globalThis, KEY);
  if (isState(found)) return found;
  const created: BridgeState = {
    announced: false,
    botId: undefined,
    cursor: undefined,
    draining: false,
    queue: [],
  };
  Reflect.set(globalThis, KEY, created);
  return created;
}
