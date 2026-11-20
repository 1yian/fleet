export const MAINTENANCE_OUTCOMES_OPTION = "--maintenance-outcomes-v1";
export const MAINTENANCE_OUTCOMES_CAPABILITY = "fleet: maintenance outcomes v1";
export const MAINTENANCE_COMMAND_MS = 90_000;
export const MAINTENANCE_SWEEP_MS = MAINTENANCE_COMMAND_MS - 10_000;

export function remainingMs(deadline = Infinity): number {
  return Math.max(0, Math.floor(deadline - performance.now()));
}
