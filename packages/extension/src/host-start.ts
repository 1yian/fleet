import type { ExecFileException } from "node:child_process";
import { diedBeforeTheCommandStarted } from "@fleet/protocol/transport";
import { isRecord } from "./lane-config.ts";

export class AgentStartRefused extends Error {}

export class AgentReadinessTimedOut extends Error {}

const startRefused = (code: unknown): boolean =>
  code === "agent_pane_busy" || code === "agent_name_taken" || code === "server_not_running";

const readinessTimeout = (payload: Record<string, unknown>): boolean =>
  isRecord(payload["error"]) &&
  payload["error"]["code"] === "timeout" &&
  payload["id"] === "cli:agent:start";

function structured(output: string): Record<string, unknown> | undefined {
  try {
    const payload: unknown = JSON.parse(output);
    return isRecord(payload) ? payload : undefined;
  } catch {
    return undefined;
  }
}

function refusalOf(output: string): string | undefined {
  const payload = structured(output);
  if (payload === undefined) return undefined;
  const detail = isRecord(payload["error"]) ? payload["error"] : payload;
  if (!startRefused(detail["code"])) return undefined;
  const message = detail["message"];
  return typeof message === "string" && message.trim() !== "" ? message : String(detail["code"]);
}

const timedOutStart = (...outputs: string[]): boolean =>
  outputs.some((text) =>
    text.split("\n").some((line) => {
      const payload = structured(line.trim());
      return payload !== undefined && readinessTimeout(payload);
    }),
  );

export const exitStatus = (error: { code?: unknown; signal?: unknown }): string =>
  typeof error.signal === "string"
    ? `killed by ${error.signal}`
    : `exit status ${String(error.code)}`;

function refusalDetail(
  file: string,
  error: ExecFileException,
  out: string,
  err: string,
): string | undefined {
  const stdout = refusalOf(out);
  const stderr = refusalOf(err);
  if (stdout !== undefined) return [stdout, stderr ?? err.trim()].filter(Boolean).join("\n");
  if (stderr !== undefined) return stderr;
  if (error.code === "ENOENT" || diedBeforeTheCommandStarted(file, error, err))
    return err.trim() || exitStatus(error);
  return undefined;
}

export function startFailure(
  file: string,
  error: ExecFileException,
  out: string,
  err: string,
  message: (detail: string) => string,
): Error | undefined {
  const refusal = refusalDetail(file, error, out, err);
  if (refusal !== undefined) return new AgentStartRefused(message(refusal));
  if (!timedOutStart(out, err)) return undefined;
  return new AgentReadinessTimedOut(message(err.trim() || out.trim() || exitStatus(error)));
}

export function startError(
  error: Record<string, unknown>,
  reply: Record<string, unknown>,
  message: string,
): Error | undefined {
  if (startRefused(error["code"])) return new AgentStartRefused(message);
  return readinessTimeout(reply) ? new AgentReadinessTimedOut(message) : undefined;
}
