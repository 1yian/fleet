import { setTimeout as sleep } from "node:timers/promises";

export const MAINTENANCE_OUTCOMES_OPTION = "--maintenance-outcomes-v1";
export const MAINTENANCE_OUTCOMES_CAPABILITY = "fleet: maintenance outcomes v1";
export const MAINTENANCE_COMMAND_MS = 90_000;
export const MAINTENANCE_PROBE_MS = 4_000;
const DEFAULT_SWEEP_MS = MAINTENANCE_COMMAND_MS - 10_000;
const sweepMs = Number(process.env["FLEET_MAINTENANCE_SWEEP_MS"]);
export const MAINTENANCE_SWEEP_MS =
  Number.isSafeInteger(sweepMs) && sweepMs > 0
    ? Math.min(sweepMs, DEFAULT_SWEEP_MS)
    : DEFAULT_SWEEP_MS;

export function remainingMs(deadline = Infinity): number {
  return Math.max(0, Math.floor(deadline - performance.now()));
}

export function within<T>(work: Promise<T>, deadline?: number): Promise<T | undefined> {
  if (deadline === undefined) return work;
  return Promise.race([work, sleep(remainingMs(deadline), undefined, { ref: false })]);
}

const DEFAULT_LANE_OBSERVATION_MS = 18_000;
const laneObservation = Number(process.env["FLEET_LANE_OBSERVATION_MS"]);
export const LANE_OBSERVATION_MS =
  Number.isSafeInteger(laneObservation) && laneObservation > 0
    ? Math.min(laneObservation, DEFAULT_LANE_OBSERVATION_MS)
    : DEFAULT_LANE_OBSERVATION_MS;
