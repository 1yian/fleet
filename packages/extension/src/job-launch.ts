import { check, OPS } from "@fleet/protocol";
import { quote } from "@fleet/protocol/route";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { herdr } from "./host.ts";
import { jobHandshake } from "./job-http.ts";
import type { Link } from "./link.ts";
import { forwardedEnvironment } from "./scratch.ts";

const WRAPPER = fileURLToPath(new URL("./job.ts", import.meta.url));
const PREPARE_ATTEMPTS = 3;
const TAB_CLOSE_ATTEMPTS = 3;
export const CALL_DEADLINE_MS = 5000;

export function present(value: string | undefined, what: string): string {
  if (value === undefined || value.trim() === "")
    throw new Error(`herdr did not return the job ${what}`);
  return value;
}

export async function prepareJob(
  endpoint: { url: string; token: string },
  link: Link,
  id: string,
  label: string,
  command: string,
): Promise<{ job: number; heartbeatMs: number; registeredLaunch: boolean }> {
  const args = { launch: id, label, command };
  for (let attempt = 0; attempt < PREPARE_ATTEMPTS; attempt += 1) {
    const receipt = await jobHandshake(endpoint, "job.prepare", args)
      .then((reply) =>
        reply.ok ? { ...reply, value: check(OPS["job.prepare"].result, reply.value) } : reply,
      )
      .catch(() => undefined);
    if (receipt === undefined) continue;
    if (receipt.ok) {
      if ("unavailable" in receipt.value)
        throw new Error(
          `Job ${String(receipt.value.job)} cannot start: ${receipt.value.unavailable}`,
        );
      return { ...receipt.value, registeredLaunch: true };
    }
    if (
      attempt === 0 &&
      receipt.status === 400 &&
      receipt.error === "unknown operation job.prepare"
    )
      return {
        ...(await link.call("job.start", { label, command }, CALL_DEADLINE_MS)),
        registeredLaunch: false,
      };
    throw new Error(receipt.error);
  }
  throw new Error(`Could not confirm the reservation for ${label}; no command was launched`);
}

export async function closeJobTab(
  warn: (text: string) => void,
  job: number,
  tab: string,
): Promise<void> {
  for (let attempt = 1; attempt <= TAB_CLOSE_ATTEMPTS; attempt += 1) {
    try {
      await herdr("local", ["tab", "close", tab]);
      return;
    } catch (error) {
      if (attempt === TAB_CLOSE_ATTEMPTS) {
        const why = error instanceof Error ? error.message : String(error);
        warn(`Job ${String(job)} did not start, but its tab ${tab} could not be closed: ${why}`);
      } else await delay(200);
    }
  }
}

export function createJobTab(workspace: string, tab: string): Promise<Record<string, unknown>> {
  return herdr("local", [
    "tab",
    "create",
    "--workspace",
    workspace,
    "--cwd",
    process.cwd(),
    "--label",
    tab,
    "--no-focus",
    ...forwardedEnvironment(process.env).flatMap((pair) => ["--env", pair]),
  ]);
}

export function runWrapper(pane: string, file: string): Promise<Error | undefined> {
  return herdr("local", ["pane", "run", pane, `node ${quote(WRAPPER)} ${quote(file)}`]).then(
    () => undefined,
    (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
  );
}
