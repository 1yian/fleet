import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SHELL_TOOLS: ReadonlySet<string> = new Set(["bash", "run_long"]);
const SEGMENT = "[^|;&\\n]*?";

const DAEMON_ADMIN: readonly RegExp[] = [
  new RegExp(
    `\\bno-mistakes\\b${SEGMENT}\\bdaemon\\s+(start|stop|restart|update|install|uninstall)\\b`,
  ),
  new RegExp(`\\b(systemctl|launchctl|service)\\b${SEGMENT}no-mistakes`, "i"),
  new RegExp(`\\b(pkill|killall)\\b${SEGMENT}no-mistakes`, "i"),
];

const DAEMON_REASON =
  "refused: the no-mistakes daemon is shared by everything on this host, and a stop or restart disrupts work of other cards. Fleet never starts, stops, or restarts it. If the daemon is down, report blocked and say so: your first mate hears of it.";

const SIGNAL_BY_NAME: ReadonlySet<string> = new Set(["pkill", "killall"]);
const LISTER = "(\\S*/)?(pgrep|pidof|ps)\\b";
const KILL_FED_BY_LISTER: readonly RegExp[] = [
  new RegExp(`\\bkill\\b[^|;&\\n]*(\\$\\(|\`)\\s*${LISTER}`),
  new RegExp(
    `(^|[|;&\\n(\`]|\\$\\()\\s*${LISTER}[^;&\\n]*\\|[^;&\\n]*\\bxargs\\b[^|;&\\n]*\\bkill\\b`,
  ),
];
const PREFIXES: ReadonlySet<string> = new Set([
  "sudo",
  "nohup",
  "exec",
  "command",
  "env",
  "time",
  "timeout",
  "xargs",
]);

const PATTERN_KILL_REASON =
  "refused: pkill, killall, and kill fed by pgrep, pidof, or ps signal every matching process of this account on the host, including other workers' test runs, builds, and jobs. Signal only a PID that you started yourself, or stop your own job with stop_job.";

const isPrefixArgument = (word: string): boolean =>
  word.startsWith("-") ||
  /^[A-Za-z_][A-Za-z0-9_]*=/.test(word) ||
  /^\d+(\.\d+)?[smhd]?$/.test(word);

function programOf(segment: string): string | undefined {
  const words = segment.trim().split(/\s+/);
  const program = words.find((word) => !PREFIXES.has(word) && !isPrefixArgument(word));
  return program?.split("/").at(-1);
}

function signalsByPattern(command: string): boolean {
  const programs = command.split(/\$\(|[|;&\n(){}`]/).map(programOf);
  if (programs.some((program) => program !== undefined && SIGNAL_BY_NAME.has(program))) return true;
  return KILL_FED_BY_LISTER.some((pattern) => pattern.test(command));
}

function guardReason(command: string): string | undefined {
  if (DAEMON_ADMIN.some((pattern) => pattern.test(command))) return DAEMON_REASON;
  if (signalsByPattern(command)) return PATTERN_KILL_REASON;
  return undefined;
}

export function registerGuard(pi: ExtensionAPI): void {
  pi.on("tool_call", (event) => {
    if (!SHELL_TOOLS.has(event.toolName)) return undefined;
    const command: unknown = Reflect.get(event.input, "command");
    if (typeof command !== "string") return undefined;
    const reason = guardReason(command);
    return reason === undefined ? undefined : { block: true, reason };
  });
}
