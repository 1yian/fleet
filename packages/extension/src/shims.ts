import { delimiter } from "node:path";
import { fileURLToPath } from "node:url";

export const PATTERN_KILL_REASON =
  "refused: pkill, killall, and kill fed by pgrep, pidof, or ps signal every matching process of this account on the host, including other workers' test runs, builds, and jobs. Signal only a PID that you started yourself, or stop your own job with stop_job.";

const SHIMS_DIR = fileURLToPath(new URL("../shims", import.meta.url));

export function shimmedEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const path = (env["PATH"] ?? "").split(delimiter).filter((entry) => entry !== SHIMS_DIR);
  return {
    ...env,
    PATH: [SHIMS_DIR, ...path].join(delimiter),
    FLEET_KILL_REFUSAL: PATTERN_KILL_REASON,
  };
}

export function shimKillCommands(): void {
  Object.assign(process.env, shimmedEnv(process.env));
}
