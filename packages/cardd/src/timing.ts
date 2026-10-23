export const MINUTE = 60_000;

export interface Timings {
  readonly every: number;
  readonly neverConnected: number;
  readonly notConnected: number;
  readonly stall: number;
  readonly spin: number;
  readonly idleNudge: number;
  readonly idleTell: number;
  readonly heartbeat: number;
  readonly intake: number;
  readonly intakeTold: number;
  readonly reply: number;
  readonly verify: number;
  readonly batch: number;
  readonly retryDelays: readonly number[];
  readonly repeat: number;
  readonly finished: number;
  readonly waiting: number;
  readonly decision: number;
  readonly wall: () => number;
}

export function timings(scale: number, wall: () => number = Date.now): Timings {
  const at = (minutes: number): number => Math.max(1, Math.round(minutes * MINUTE * scale));
  return {
    every: at(0.25),
    neverConnected: at(2),
    notConnected: at(2),
    stall: at(5),
    spin: at(60),
    idleNudge: at(2),
    idleTell: at(5),
    heartbeat: at(0.5),
    intake: at(2),
    intakeTold: at(15),
    reply: at(2),
    verify: at(10),
    batch: at(5),
    retryDelays: [at(0.5), at(2)],
    repeat: at(5),
    finished: at(120),
    waiting: at(15),
    decision: at(240),
    wall,
  };
}
