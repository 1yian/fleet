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

const KEYWORDS: ReadonlySet<string> = new Set([
  "if",
  "then",
  "else",
  "elif",
  "do",
  "while",
  "until",
  "!",
]);

const isAssignment = (word: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);
const baseName = (word: string): string | undefined => word.split("/").at(-1);

interface Parsed {
  segments: string[][];
  masked: string;
}

function parse(command: string): Parsed {
  const segments: string[][] = [[]];
  let masked = "";
  let word: string | undefined;
  let quote: string | undefined;
  const endWord = (): void => {
    if (word !== undefined) segments.at(-1)?.push(word);
    word = undefined;
  };
  const endSegment = (): void => {
    endWord();
    segments.push([]);
  };
  for (let i = 0; i < command.length; i++) {
    const char = command.charAt(i);
    if (quote === "'") {
      if (char === "'") {
        quote = undefined;
        masked += char;
      } else {
        word = (word ?? "") + char;
        masked += " ";
      }
      continue;
    }
    masked += char;
    if (char === "\\" && i + 1 < command.length) {
      i++;
      const next = command.charAt(i);
      word = (word ?? "") + next;
      masked += next;
    } else if (char === quote) {
      quote = undefined;
    } else if (char === "$" && command.charAt(i + 1) === "(") {
      i++;
      masked += "(";
      endSegment();
    } else if (char === "`") {
      endSegment();
    } else if (quote === '"') {
      word = (word ?? "") + char;
    } else if (char === "'" || char === '"') {
      quote = char;
      word ??= "";
    } else if (/\s/.test(char) && char !== "\n") {
      endWord();
    } else if ("|;&\n(){}".includes(char)) {
      endSegment();
    } else {
      word = (word ?? "") + char;
    }
  }
  endWord();
  return { segments, masked };
}

function signalsByName(words: string[]): boolean {
  const rest = words.filter((word) => !KEYWORDS.has(word) && !isAssignment(word));
  const program = rest[0] === undefined ? undefined : baseName(rest[0]);
  if (program === undefined) return false;
  if (SIGNAL_BY_NAME.has(program)) return true;
  if (!PREFIXES.has(program)) return false;
  return rest.slice(1).some((word) => SIGNAL_BY_NAME.has(baseName(word) ?? ""));
}

function signalsByPattern(command: string): boolean {
  const { segments, masked } = parse(command);
  if (segments.some(signalsByName)) return true;
  return KILL_FED_BY_LISTER.some((pattern) => pattern.test(masked));
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
