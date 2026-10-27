import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mergeReason } from "./merge-guard.ts";
import { PATTERN_KILL_REASON } from "./shims.ts";

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

const LISTER = "(\\S*/)?(pgrep|pidof|ps)\\b";
const KILL_FED_BY_LISTER: readonly RegExp[] = [
  new RegExp(`\\bkill\\b[^|;&\\n]*(\\$\\(|\`)\\s*${LISTER}`),
  new RegExp(
    `(^|[|;&\\n(\`]|\\$\\()\\s*${LISTER}[^;&\\n]*\\|[^;&\\n]*\\bxargs\\b[^|;&\\n]*\\bkill\\b`,
  ),
];

function guardReason(command: string): string | undefined {
  if (DAEMON_ADMIN.some((pattern) => pattern.test(command))) return DAEMON_REASON;
  if (KILL_FED_BY_LISTER.some((pattern) => pattern.test(command))) return PATTERN_KILL_REASON;
  return undefined;
}

export function registerGuard(pi: ExtensionAPI, role: "worker" | "mate"): void {
  pi.on("tool_call", async (event) => {
    if (!SHELL_TOOLS.has(event.toolName)) return undefined;
    const command: unknown = Reflect.get(event.input, "command");
    if (typeof command !== "string") return undefined;
    const reason =
      guardReason(command) ?? (role === "worker" ? await mergeReason(command) : undefined);
    return reason === undefined ? undefined : { block: true, reason };
  });
}
