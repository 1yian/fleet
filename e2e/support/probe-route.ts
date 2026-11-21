import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./run-root.ts";

type Verdict = "live" | "absent" | "offline" | "partial" | "missing";

const SCRIPT = `mode=$(cat "$FLEET_PROBE_MODE" 2>/dev/null); mode=\${mode:-live}; printf '%s\\n' "$mode" >> "$FLEET_PROBE_LOG"
case "$mode" in
  absent) exit 1 ;;
  offline) exit 255 ;;
  partial) exit 0 ;;
  missing) exit 127 ;;
esac
exec sh -c "$1"`;

export class ProbeRoute {
  private readonly mode: string;
  private readonly log: string;

  constructor() {
    const dir = tempDir("fleet-probe-");
    this.mode = join(dir, "mode");
    this.log = join(dir, "log");
    writeFileSync(this.log, "");
    this.say("live");
  }

  get hosts(): string {
    const route = [
      "env",
      `FLEET_PROBE_MODE=${this.mode}`,
      `FLEET_PROBE_LOG=${this.log}`,
      "sh",
      "-c",
      SCRIPT,
      "probe",
    ];
    return JSON.stringify({ local: route, maverick: route, p620: route });
  }

  say(verdict: Verdict): void {
    writeFileSync(`${this.mode}.next`, verdict);
    renameSync(`${this.mode}.next`, this.mode);
  }

  silence(wrapper: number): void {
    process.kill(wrapper, "SIGSTOP");
    this.say("absent");
  }

  resume(wrapper: number): void {
    this.say("live");
    process.kill(wrapper, "SIGCONT");
  }

  count(verdict: Verdict): number {
    return readFileSync(this.log, "utf8")
      .split("\n")
      .filter((line) => line === verdict).length;
  }
}
