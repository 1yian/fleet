export const MINUTE = 60_000;

export interface Timings {
  readonly every: number;
  readonly neverConnected: number;
  readonly notConnected: number;
  readonly stall: number;
  readonly idle: number;
  readonly heartbeat: number;
  readonly intake: number;
  readonly reply: number;
  readonly reminders: readonly number[];
  readonly finished: readonly number[];
  readonly escalations: readonly number[];
}

export function timings(scale: number): Timings {
  const at = (minutes: number): number => Math.max(1, Math.round(minutes * MINUTE * scale));
  return {
    every: at(1),
    neverConnected: at(2),
    notConnected: at(2),
    stall: at(15),
    idle: at(2),
    heartbeat: at(0.5),
    intake: at(2),
    reply: at(5),
    reminders: [at(30), at(60), at(120), at(360)],
    finished: [at(5), at(15), at(30), at(60), at(120), at(360)],
    escalations: [at(30), at(120), at(360)],
  };
}
