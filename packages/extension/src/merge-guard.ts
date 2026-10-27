import { execFile } from "node:child_process";

interface MergeAttempt {
  readonly ref: string | undefined;
  readonly repo: string | undefined;
  readonly host: string | undefined;
  readonly sha: string | undefined;
}

const GH_PR_MERGE = /\bgh\b([^|;&\n]*?)\bpr\s+merge\b/g;
const GH_API = /\bgh\s+api\b/g;
const GRAPHQL_MERGE = /\b(mergePullRequest|enablePullRequestAutoMerge)\b/;
const MERGE_PATH = /(?:^|\/)repos\/([^/\s]+\/[^/\s]+)\/pulls\/(\d+)\/merge$/;
const EXPANSION = "\u0000";
const URL_REF = /^https?:\/\//;
const ENV_SHIFT = /\b(?:GH_REPO|GH_HOST)=/;
const CWD_SHIFT = /(?:^|[\s;&|(])(?:cd|pushd|export|env)\s/;
const LOOKUP_TIMEOUT_MS = 30_000;

const PR_FLAGS_WITH_VALUE: ReadonlySet<string> = new Set([
  "-R",
  "--repo",
  "-b",
  "--body",
  "-F",
  "--body-file",
  "-t",
  "--subject",
  "-A",
  "--author-email",
  "--match-head-commit",
]);
const API_FLAGS_WITH_VALUE: ReadonlySet<string> = new Set([
  "-X",
  "--method",
  "-f",
  "-F",
  "--field",
  "--raw-field",
  "-H",
  "--header",
  "--hostname",
  "-q",
  "--jq",
  "-t",
  "--template",
  "--input",
  "--cache",
]);

const MERGE_GRAPHQL_REASON =
  "refused: a GraphQL merge mutation cannot be checked against the PR's checks, and a query read from --input or an @file cannot be classified. Inline the query in the command, or merge with `gh pr merge <url> --match-head-commit <sha>` once every check on the PR's head commit has completed and passed.";
const CONTEXT_REASON =
  "refused: the merge's repository cannot be resolved faithfully (GH_REPO, GH_HOST, cd, or a similar change of context). Name the PR with its full URL or pass -R <owner/repo>, and do not change the environment or directory in the same command.";

function marked(char: string, expands: boolean): string {
  return expands && /[$`]/.test(char) ? char + EXPANSION : char;
}

function tokenize(text: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: string | undefined;
  let started = false;
  const flush = (): void => {
    if (started) tokens.push(current);
    current = "";
    started = false;
  };
  for (const char of text) {
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
      else current += marked(char, quote === '"');
    } else if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (/[|;&()\n]/.test(char)) {
      flush();
      return tokens;
    } else if (/\s/.test(char)) {
      flush();
    } else {
      current += marked(char, true);
      started = true;
    }
  }
  flush();
  return tokens;
}

function splitFlags(args: readonly string[], withValue: ReadonlySet<string>): string[] {
  return args.flatMap((token) => {
    const eq = token.indexOf("=");
    if (token.startsWith("--") && eq > 0 && withValue.has(token.slice(0, eq)))
      return [token.slice(0, eq), token.slice(eq + 1)];
    const short = token.slice(0, 2);
    if (!token.startsWith("--") && token.length > 2 && withValue.has(short))
      return [short, token.slice(2)];
    return [token];
  });
}

interface ParsedArgs {
  readonly entries: readonly (readonly [string, string])[];
  readonly bare: ReadonlySet<string>;
  readonly positionals: readonly string[];
}

function parseArgs(raw: readonly string[], withValue: ReadonlySet<string>): ParsedArgs {
  const args = splitFlags(raw, withValue);
  const entries: [string, string][] = [];
  const bare = new Set<string>();
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i] ?? "";
    if (withValue.has(token)) entries.push([token, args[(i += 1)] ?? ""]);
    else if (token.startsWith("-")) bare.add(token);
    else positionals.push(token);
  }
  return { entries, bare, positionals };
}

function flagValues(parsed: ParsedArgs, ...names: string[]): string[] {
  return parsed.entries.filter(([name]) => names.includes(name)).map(([, value]) => value);
}

function flagValue(parsed: ParsedArgs, ...names: string[]): string | undefined {
  return flagValues(parsed, ...names).at(-1);
}

function prMergeAttempt(
  prefix: readonly string[],
  args: readonly string[],
): MergeAttempt | undefined {
  const parsed = parseArgs(args, PR_FLAGS_WITH_VALUE);
  if (parsed.bare.has("--disable-auto")) return undefined;
  const globals = parseArgs(prefix, PR_FLAGS_WITH_VALUE);
  return {
    ref: parsed.positionals[0],
    repo: flagValue(parsed, "-R", "--repo") ?? flagValue(globals, "-R", "--repo"),
    host: undefined,
    sha: flagValue(parsed, "--match-head-commit"),
  };
}

const FIELD_FLAGS = ["-f", "-F", "--field", "--raw-field"];

function isGraphql(endpoint: string | undefined): boolean {
  return endpoint === "graphql" || /^https?:\/\/[^?#]*\/graphql\/?(?:[?#]|$)/.test(endpoint ?? "");
}

function carriesGraphqlMerge(parsed: ParsedArgs): boolean {
  const fields = flagValues(parsed, ...FIELD_FLAGS);
  const query = fields.filter((value) => value.startsWith("query="));
  return (
    parsed.entries.some(([name]) => name === "--input") ||
    query.some((value) => value.startsWith("query=@") || value.includes(EXPANSION)) ||
    fields.some((value) => GRAPHQL_MERGE.test(value))
  );
}

function isGet(parsed: ParsedArgs): boolean {
  const method = flagValue(parsed, "-X", "--method");
  if (method !== undefined) return method.toUpperCase() === "GET";
  return flagValues(parsed, ...FIELD_FLAGS, "--input").length === 0;
}

function bodySha(parsed: ParsedArgs): string | undefined {
  return flagValues(parsed, ...FIELD_FLAGS)
    .filter((value) => value.startsWith("sha="))
    .at(-1)
    ?.slice(4);
}

function endpointTarget(
  endpoint: string,
  hostname: string | undefined,
): { path: string; host: string | undefined } {
  if (!URL_REF.test(endpoint)) return { path: endpoint, host: hostname };
  const url = new URL(endpoint);
  return { path: url.pathname, host: url.hostname === "api.github.com" ? "github.com" : url.host };
}

function apiMergeAttempt(parsed: ParsedArgs): MergeAttempt | undefined {
  const endpoint = parsed.positionals[0];
  if (endpoint === undefined || isGet(parsed)) return undefined;
  const target = endpointTarget(endpoint, flagValue(parsed, "--hostname"));
  const match = MERGE_PATH.exec(target.path);
  if (match?.[1] === undefined || match[2] === undefined) return undefined;
  const repo = match[1].includes("{") ? undefined : match[1];
  return { ref: match[2], repo, host: target.host, sha: bodySha(parsed) };
}

type MergeDetection =
  | { readonly kind: "none" }
  | { readonly kind: "graphql" }
  | { readonly kind: "merge"; readonly attempts: readonly MergeAttempt[] };

function detectMerge(raw: string): MergeDetection {
  const command = raw.replace(/\\\r?\n/g, " ");
  const attempts: MergeAttempt[] = [];
  for (const match of command.matchAll(GH_PR_MERGE)) {
    const rest = command.slice(match.index + match[0].length);
    const attempt = prMergeAttempt(tokenize(match[1] ?? ""), tokenize(rest));
    if (attempt !== undefined) attempts.push(attempt);
  }
  for (const match of command.matchAll(GH_API)) {
    const rest = command.slice(match.index + match[0].length);
    const parsed = parseArgs(tokenize(rest), API_FLAGS_WITH_VALUE);
    if (isGraphql(parsed.positionals[0]) && carriesGraphqlMerge(parsed)) return { kind: "graphql" };
    const attempt = apiMergeAttempt(parsed);
    if (attempt !== undefined) attempts.push(attempt);
  }
  return attempts.length === 0 ? { kind: "none" } : { kind: "merge", attempts };
}

function gh(args: readonly string[], host: string | undefined): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "gh",
      [...args],
      {
        encoding: "utf8",
        timeout: LOOKUP_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
        env: host === undefined ? process.env : { ...process.env, GH_HOST: host },
      },
      (error, stdout, stderr) => {
        if (error === null) resolve(stdout);
        else reject(new Error(stderr.trim() || error.message));
      },
    );
  });
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

const PASSING_CONCLUSIONS: ReadonlySet<string> = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
const PENDING_STATES: ReadonlySet<string> = new Set(["PENDING", "EXPECTED"]);

function describeStatus(entry: Record<string, unknown>): string | undefined {
  const state = text(entry["state"]).toUpperCase();
  if (state === "SUCCESS") return undefined;
  const label = PENDING_STATES.has(state) ? "pending" : state.toLowerCase() || "unknown";
  return `${text(entry["context"]) || "a status"}: ${label}`;
}

function describeRun(entry: Record<string, unknown>): string | undefined {
  const name = text(entry["name"]) || "a check";
  const status = text(entry["status"]).toUpperCase();
  const conclusion = text(entry["conclusion"]).toUpperCase();
  if (status === "COMPLETED" && PASSING_CONCLUSIONS.has(conclusion)) return undefined;
  const label = status === "COMPLETED" ? conclusion : status;
  return `${name}: ${label.toLowerCase().replace("_", " ") || "unknown"}`;
}

function describeCheck(raw: unknown): string | undefined {
  if (typeof raw !== "object" || raw === null) return "an unreadable check: unknown";
  const entry: Record<string, unknown> = Object.fromEntries(Object.entries(raw));
  return entry["__typename"] === "StatusContext" ? describeStatus(entry) : describeRun(entry);
}

function redChecks(rollup: unknown): string[] {
  if (!Array.isArray(rollup)) throw new Error("the check list was not an array");
  return rollup.flatMap((raw: unknown) => describeCheck(raw) ?? []);
}

async function attemptReason(attempt: MergeAttempt): Promise<string | undefined> {
  const args = ["pr", "view"];
  if (attempt.ref !== undefined) args.push(attempt.ref);
  if (attempt.repo !== undefined) args.push("-R", attempt.repo);
  args.push("--json", "headRefOid,statusCheckRollup");
  let red: string[];
  let sha: string;
  try {
    const parsed: unknown = JSON.parse(await gh(args, attempt.host));
    if (typeof parsed !== "object" || parsed === null) throw new Error("unexpected output");
    const view: Record<string, unknown> = Object.fromEntries(Object.entries(parsed));
    sha = text(view["headRefOid"]);
    red = redChecks(view["statusCheckRollup"]);
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    return `refused: could not look up the PR's checks (${why}). A merge is allowed only when every check on the head commit is known to be green. Fix the lookup or report blocked.`;
  }
  if (red.length > 0)
    return `refused: not every check on the PR's head commit${sha === "" ? "" : ` ${sha.slice(0, 12)}`} has passed:\n${red.map((line) => `- ${line}`).join("\n")}\nWait until all are green (run the wait with run_long, and gate it on the final state of every check), then merge again. --admin and --auto do not bypass this.`;
  if (attempt.sha === sha) return undefined;
  return `refused: every check on head commit ${sha} has passed, but the merge is not bound to it. Merge that exact commit: \`gh pr merge <url> --match-head-commit ${sha}\`, or for the REST API add \`-f sha=${sha}\`.`;
}

function pinned(attempt: MergeAttempt): boolean {
  return attempt.repo !== undefined || URL_REF.test(attempt.ref ?? "");
}

export async function mergeReason(command: string): Promise<string | undefined> {
  const detection = detectMerge(command);
  if (detection.kind === "none") return undefined;
  if (detection.kind === "graphql") return MERGE_GRAPHQL_REASON;
  if (ENV_SHIFT.test(command)) return CONTEXT_REASON;
  if (CWD_SHIFT.test(command) && !detection.attempts.every(pinned)) return CONTEXT_REASON;
  for (const attempt of detection.attempts) {
    const reason = await attemptReason(attempt);
    if (reason !== undefined) return reason;
  }
  return undefined;
}
