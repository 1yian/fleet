// The timers of cardd (spec section 28). One scale speeds all of them up for tests.
export const MINUTE = 60_000;

export interface Timings {
  readonly every: number;
  readonly neverConnected: number;
  readonly notConnected: number;
  readonly stall: number;
  readonly idle: number;
  /** How often a run_long wrapper tells cardd that it is alive. Three missed beats make the job lost. */
  readonly heartbeat: number;
  /** When reminders fire, counted from the last action on the card. Later ones repeat at the last gap. */
  readonly reminders: readonly number[];
}

/** The defaults of spec section 28. A scale below 1 speeds every timer up, for tests. */
export function timings(scale: number): Timings {
  const at = (minutes: number): number => Math.max(1, Math.round(minutes * MINUTE * scale));
  return {
    every: at(1),
    neverConnected: at(2),
    notConnected: at(2),
    stall: at(15),
    idle: at(2),
    heartbeat: at(0.5),
    reminders: [at(30), at(60), at(120), at(360)],
  };
}
