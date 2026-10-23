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

function guardReason(command: string): string | undefined {
  if (DAEMON_ADMIN.some((pattern) => pattern.test(command))) return DAEMON_REASON;
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
