import { fileURLToPath } from "node:url";
import {
  HostCommandFailed,
  HostUnread,
  HostUnreachable,
  onFleetRoot,
  onHost,
  records,
} from "./host.ts";
import { isRecord, type LaneConfig } from "./lane-config.ts";
import {
  MAINTENANCE_COMMAND_MS,
  MAINTENANCE_OUTCOMES_CAPABILITY,
  MAINTENANCE_OUTCOMES_OPTION,
  MAINTENANCE_PROBE_MS,
  remainingMs,
} from "./maintenance-budget.ts";

const LAUNCH = fileURLToPath(new URL("./launch.ts", import.meta.url));
const REMOTE_WAIT_MS = 90_000;

export async function fleet(
  config: LaneConfig,
  host: string,
  args: readonly string[],
  wait = REMOTE_WAIT_MS,
  hard = false,
): Promise<string> {
  if (host === "local") return onHost(host, [process.execPath, LAUNCH, ...args], wait, hard);
  return onFleetRoot(host, config.roots[host], args, wait, hard);
}

const text = (row: Record<string, unknown>, key: string): string => {
  const value = row[key];
  return typeof value === "string" ? value : "";
};
const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const MAINTENANCE_ACTIONS = new Set(["running", "started", "held", "stopped", "unread"]);

async function supportsMaintenanceOutcomes(
  config: LaneConfig,
  host: string,
  timeout: number,
): Promise<boolean> {
  if (host === "local") return true;
  try {
    const out = await fleet(config, host, [MAINTENANCE_OUTCOMES_OPTION], timeout, true);
    if (out.trim() === MAINTENANCE_OUTCOMES_CAPABILITY) return true;
  } catch (error) {
    if (error instanceof HostUnreachable) throw error;
    if (legacyRefusal(error, host)) return false;
    throw new Error(`could not verify maintenance support on ${host}: ${messageOf(error)}`, {
      cause: error,
    });
  }
  throw new Error(`could not verify maintenance support on ${host}: unexpected capability reply`);
}

function legacyRefusal(error: unknown, host: string): boolean {
  if (!(error instanceof HostCommandFailed) || error.exitCode !== 2 || error.hasOutput)
    return false;
  const refusal = `sh on ${host} failed: fleet: Unknown option '${MAINTENANCE_OUTCOMES_OPTION}'`;
  const firstLine = error.message.split("\n")[0];
  return (
    firstLine === refusal ||
    firstLine?.startsWith(`${refusal}. To specify a positional argument `) === true
  );
}

export async function maintenanceResult(
  config: LaneConfig,
  host: string,
  offsets: Map<string, number>,
) {
  const deadline = performance.now() + MAINTENANCE_COMMAND_MS;
  const typed = await supportsMaintenanceOutcomes(
    config,
    host,
    Math.min(MAINTENANCE_PROBE_MS, remainingMs(deadline)),
  );
  const timeout = remainingMs(deadline);
  if (timeout === 0) throw new HostUnread("maintenance deadline reached before sweep");
  const args = ["up", "--maintenance", "--json"];
  if (typed) {
    const offset = offsets.get(host) ?? 0;
    args.push(MAINTENANCE_OUTCOMES_OPTION, String(offset));
    offsets.set(host, offset + 1);
  }
  const out = await fleet(config, host, args, timeout, true).catch((error: unknown) => {
    if (!typed || error instanceof HostUnreachable) throw error;
    throw new HostUnread(messageOf(error));
  });
  try {
    return readMaintenanceResult(out, host, typed);
  } catch (error) {
    throw new HostUnread(messageOf(error));
  }
}

function readEnvelope(answer: unknown, host: string) {
  if (!isRecord(answer)) throw new Error(`fleet on ${host} returned no maintenance envelope`);
  const failed = Object.hasOwn(answer, "failed") ? text(answer, "failed") : undefined;
  if (failed?.trim() === "") throw new Error(`fleet on ${host} returned no failure detail`);
  const expected = answer["expected"];
  if (
    !Array.isArray(expected) ||
    !expected.every((lane) => typeof lane === "string" && lane.trim() !== "")
  )
    throw new Error(`fleet on ${host} returned no valid expected lane set`);
  const missing = new Set<string>(expected);
  if (missing.size !== expected.length)
    throw new Error(`fleet on ${host} returned duplicate expected lanes`);
  return { list: answer["outcomes"], failed, missing };
}

function validResult(row: Record<string, unknown>, missing?: Set<string>): boolean {
  const action = text(row, "action");
  const lane = text(row, "lane");
  if (lane.trim() === "" || !MAINTENANCE_ACTIONS.has(action)) return false;
  if (action === "held" && text(row, "detail") === "") return false;
  return missing === undefined ? action !== "unread" : missing.delete(lane);
}

function readMaintenanceResult(out: string, host: string, typed: boolean) {
  const answer: unknown = JSON.parse(out.trim().split("\n").at(-1) ?? "");
  const { list, failed, missing } = typed
    ? readEnvelope(answer, host)
    : { list: answer, failed: undefined, missing: undefined };
  const results = records(list);
  if (!Array.isArray(list) || results.length !== list.length)
    throw new Error(`fleet on ${host} returned an incomplete maintenance list`);
  if (results.some((row) => !validResult(row, missing)))
    throw new Error(`fleet on ${host} returned an incomplete maintenance result`);
  if (failed === undefined && missing !== undefined && missing.size > 0)
    throw new Error(`fleet on ${host} omitted maintenance outcomes`);
  return { results, failed };
}
