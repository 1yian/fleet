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
const LISTERS: ReadonlySet<string> = new Set(["pgrep", "pidof", "ps"]);
const WRAPPERS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["sudo", new Set(["-u", "-g", "-h", "-p", "-C", "-D", "-R", "-T", "-U"])],
  ["nohup", new Set<string>()],
  ["exec", new Set(["-a"])],
  ["command", new Set<string>()],
  ["env", new Set(["-u", "-C", "-S"])],
  ["time", new Set(["-f", "-o"])],
  ["timeout", new Set(["-s", "-k"])],
  ["nice", new Set(["-n"])],
  ["xargs", new Set(["-n", "-I", "-L", "-P", "-d", "-s", "-E", "-a"])],
]);
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

const PATTERN_KILL_REASON =
  "refused: pkill, killall, and kill fed by pgrep, pidof, or ps signal every matching process of this account on the host, including other workers' test runs, builds, and jobs. Signal only a PID that you started yourself, or stop your own job with stop_job.";

interface Cmd {
  words: string[];
  pipeline: number;
  subs: Cmd[];
}

interface Walk {
  src: string;
  pos: number;
  pipelines: number;
  all: Cmd[];
}

const isAssignment = (word: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);
const baseName = (word: string): string => word.split("/").at(-1) ?? word;

function walk(state: Walk, closer: string | undefined): Cmd[] {
  const first = state.all.length;
  let pipeline = state.pipelines++;
  let cmd: Cmd = { words: [], pipeline, subs: [] };
  let word: string | undefined;
  let quote: string | undefined;
  let depth = 0;
  const endWord = (): void => {
    if (word !== undefined) cmd.words.push(word);
    word = undefined;
  };
  const endCommand = (newPipeline: boolean): void => {
    endWord();
    if (newPipeline) pipeline = state.pipelines++;
    cmd = { words: [], pipeline, subs: [] };
  };
  const register = (): void => {
    if (!state.all.includes(cmd)) state.all.push(cmd);
  };
  const substitute = (end: string): void => {
    register();
    cmd.subs.push(...walk(state, end));
    word = (word ?? "") + "\u0000";
  };
  while (state.pos < state.src.length) {
    const char = state.src.charAt(state.pos);
    const next = state.src.charAt(state.pos + 1);
    state.pos++;
    if (quote === "'") {
      if (char === "'") quote = undefined;
      else word = (word ?? "") + char;
      continue;
    }
    if (char === "\\") {
      word = (word ?? "") + next;
      state.pos++;
    } else if (char === "$" && next === "(") {
      state.pos++;
      substitute(")");
    } else if (char === "`") {
      if (closer === "`") break;
      substitute("`");
    } else if (quote === '"') {
      if (char === '"') quote = undefined;
      else word = (word ?? "") + char;
    } else if (char === "'" || char === '"') {
      quote = char;
      word ??= "";
    } else if (/[ \t\r]/.test(char)) {
      endWord();
    } else if (char === "|") {
      if (next === "|") {
        state.pos++;
        register();
        endCommand(true);
      } else {
        if (next === "&") state.pos++;
        register();
        endCommand(false);
      }
    } else if (
      char === "&" &&
      (next === ">" || [">", "<"].includes(state.src.charAt(state.pos - 2)))
    ) {
      word = (word ?? "") + char;
    } else if (char === ")" && depth === 0 && closer === ")") {
      break;
    } else if (";&\n(){}".includes(char)) {
      if (char === "(") depth++;
      if (char === ")") depth--;
      register();
      endCommand(true);
    } else {
      word = (word ?? "") + char;
    }
  }
  endWord();
  register();
  return state.all.slice(first).filter((entry) => entry.words.length > 0 || entry.subs.length > 0);
}

function chainOf(words: string[]): string[] {
  const chain: string[] = [];
  let i = 0;
  const at = (index: number): string => words.at(index) ?? "";
  while (i < words.length && (KEYWORDS.has(at(i)) || isAssignment(at(i)))) i++;
  while (i < words.length) {
    const program = baseName(at(i));
    chain.push(program);
    const optionsWithArgument = WRAPPERS.get(program);
    if (optionsWithArgument === undefined) break;
    i++;
    while (i < words.length) {
      const word = at(i);
      if (program === "command" && (word === "-v" || word === "-V")) return chain;
      if (word.startsWith("-")) i += optionsWithArgument.has(word) ? 2 : 1;
      else if (program === "env" && isAssignment(word)) i++;
      else break;
    }
    if (program === "timeout") i++;
  }
  return chain;
}

const hasProgram = (cmd: Cmd, names: ReadonlySet<string>): boolean =>
  chainOf(cmd.words).some((program) => names.has(program));

function signalsByPattern(command: string): boolean {
  const state: Walk = { src: command, pos: 0, pipelines: 0, all: [] };
  walk(state, undefined);
  const { all } = state;
  if (all.some((cmd) => hasProgram(cmd, SIGNAL_BY_NAME))) return true;
  const fed = all.some(
    (cmd) => hasProgram(cmd, new Set(["kill"])) && cmd.subs.some((sub) => hasProgram(sub, LISTERS)),
  );
  if (fed) return true;
  return all.some(
    (lister) =>
      hasProgram(lister, LISTERS) &&
      all.some(
        (sink) =>
          sink.pipeline === lister.pipeline &&
          hasProgram(sink, new Set(["xargs"])) &&
          hasProgram(sink, new Set(["kill"])),
      ),
  );
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
