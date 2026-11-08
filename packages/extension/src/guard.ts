import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PATTERN_KILL_REASON } from "./shims.ts";

const SHELL_TOOLS: ReadonlySet<string> = new Set(["bash", "run_long"]);
const LISTER = "(\\S*/)?(pgrep|pidof|ps)\\b";
const KILL_FED_BY_LISTER: readonly RegExp[] = [
  new RegExp(`\\bkill\\b[^|;&\\n]*(\\$\\(|\`)\\s*${LISTER}`),
  new RegExp(
    `(^|[|;&\\n(\`]|\\$\\()\\s*${LISTER}[^;&\\n]*\\|[^;&\\n]*\\bxargs\\b[^|;&\\n]*\\bkill\\b`,
  ),
];

function guardReason(command: string): string | undefined {
  if (KILL_FED_BY_LISTER.some((pattern) => pattern.test(command))) return PATTERN_KILL_REASON;
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
