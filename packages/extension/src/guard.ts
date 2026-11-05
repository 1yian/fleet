import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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

const PREFIXES = "(?:sudo|env|command|exec|nohup|time|nice|caffeinate)\\b(?:\\s+-\\S+)*\\s+";
const SHELL_C = "(?:\\S*/)?(?:ba|z|da)?sh\\s+(?:-\\S+\\s+)*?-\\w*c\\s+[\"']?";
const AT_COMMAND = `(?:^|[|;&\\n(\`]|\\$\\()\\s*(?:[A-Za-z_]\\w*=\\S*\\s+|${PREFIXES}|eval\\s+["']?|${SHELL_C})*`;
const NAMED_SAFARI = "(?<![\\w-])safari(?![\\w-]|\\.(?!app\\b))";
const REMOTE_SHELL = "(?:(?:\\S*/)?(?:ssh|mosh)|(?:\\S*/)?tailscale\\s+ssh)";

const PERSONAL_SAFARI: readonly RegExp[] = [
  new RegExp(`${AT_COMMAND}(?:\\S*/)?osascript\\b[\\s\\S]*${NAMED_SAFARI}`, "i"),
  new RegExp(`${AT_COMMAND}(?:\\S*/)?open(?=\\s)[^|;&\\n]*${NAMED_SAFARI}`, "i"),
  new RegExp(`${AT_COMMAND}(?:\\S*/)?safaridriver\\b`, "i"),
  new RegExp(
    `${AT_COMMAND}${REMOTE_SHELL}\\b[\\s\\S]*?(?:\\b(?:osascript|open)\\b[\\s\\S]*${NAMED_SAFARI}|\\bsafaridriver\\b)`,
    "i",
  ),
];

const SAFARI_REASON =
  "refused: Safari on the captain's Mac (frontera) is his personal browser, and no agent drives it. Use the fleet's shared Chrome with browser-axi, or a browser of your own with its own profile. This guard stops the recognizable commands: osascript or open -a naming Safari, safaridriver, and those run over ssh. If the task cannot be done without his own Safari session, report blocked and say why: your first mate asks him.";

const LISTER = "(\\S*/)?(pgrep|pidof|ps)\\b";
const KILL_FED_BY_LISTER: readonly RegExp[] = [
  new RegExp(`\\bkill\\b[^|;&\\n]*(\\$\\(|\`)\\s*${LISTER}`),
  new RegExp(
    `(^|[|;&\\n(\`]|\\$\\()\\s*${LISTER}[^;&\\n]*\\|[^;&\\n]*\\bxargs\\b[^|;&\\n]*\\bkill\\b`,
  ),
];

function guardReason(command: string): string | undefined {
  if (DAEMON_ADMIN.some((pattern) => pattern.test(command))) return DAEMON_REASON;
  if (PERSONAL_SAFARI.some((pattern) => pattern.test(command))) return SAFARI_REASON;
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
