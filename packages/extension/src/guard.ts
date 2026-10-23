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

const WORKER_DRIVES = new RegExp(
  `\\bno-mistakes\\b${SEGMENT}\\b(axi\\s+(run|respond|answer)|rerun)\\b`,
);

const DAEMON_REASON =
  "refused: the no-mistakes daemon is shared by every run on this host, and a stop or restart fails the runs of other cards. Fleet never starts, stops, or restarts it. If the daemon is down, report blocked and say so: the first mate hears of it.";
const DRIVE_REASON =
  "refused: drive the no-mistakes run with the validate tool, not by hand. validate binds the run to your card, reattaches itself when a wait ends, and tells your first mate once if the run fails. Use validate(), validate(respond=...), or validate(answer=...).";

function guardReason(role: "worker" | "mate", command: string): string | undefined {
  if (DAEMON_ADMIN.some((pattern) => pattern.test(command))) return DAEMON_REASON;
  if (role === "worker" && WORKER_DRIVES.test(command)) return DRIVE_REASON;
  return undefined;
}

export function registerGuard(pi: ExtensionAPI, role: "worker" | "mate"): void {
  pi.on("tool_call", (event) => {
    if (!SHELL_TOOLS.has(event.toolName)) return undefined;
    const command: unknown = Reflect.get(event.input, "command");
    if (typeof command !== "string") return undefined;
    const reason = guardReason(role, command);
    return reason === undefined ? undefined : { block: true, reason };
  });
}
