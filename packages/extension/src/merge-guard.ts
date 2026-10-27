import { execFile } from "node:child_process";

interface MergeAttempt {
  readonly ref: string | undefined;
  readonly repo: string | undefined;
}

const GH_PR_MERGE = /\bgh\b[^|;&\n]*?\bpr\s+merge\b/g;
const GH_API = /\bgh\s+api\b/g;
const GRAPHQL_MERGE = /\b(mergePullRequest|enablePullRequestAutoMerge)\b/;
const MERGE_PATH = /(?:^|\/)repos\/([^/\s]+\/[^/\s]+)\/pulls\/(\d+)\/merge$/;
const SHORT_MERGE_PATH = /(?:^|\/)pulls\/(\d+)\/merge$/;
const LOOKUP_TIMEOUT_MS = 30_000;

const FLAGS_WITH_VALUE: ReadonlySet<string> = new Set([
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
  "refused: a GraphQL merge mutation cannot be checked against the PR's checks. Merge with `gh pr merge <url>` once every check on the PR's head commit has completed and passed.";

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
      else current += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      flush();
    } else if (/[|;&()`\n]/.test(char)) {
      flush();
      return tokens;
    } else {
      current += char;
      started = true;
    }
  }
  flush();
  return tokens;
}

const BODY_FLAGS: ReadonlySet<string> = new Set(["-f", "-F", "--field", "--raw-field"]);

function inlineRepo(token: string): string | undefined {
  if (token.startsWith("--repo=")) return token.slice(7);
  if (token.startsWith("-R") && !token.startsWith("--")) return token.slice(2) || undefined;
  return undefined;
}

function prMergeAttempt(args: readonly string[]): MergeAttempt {
  let ref: string | undefined;
  let repo: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i] ?? "";
    const inline = inlineRepo(token);
    if (token === "-R" || token === "--repo") repo = args[(i += 1)];
    else if (inline !== undefined) repo = inline;
    else if (FLAGS_WITH_VALUE.has(token)) i += 1;
    else if (!token.startsWith("-") && ref === undefined) ref = token;
  }
  return { ref, repo };
}

function carriesGraphqlMerge(args: readonly string[]): boolean {
  return args.some(
    (token, i) =>
      GRAPHQL_MERGE.test(token) && (token.startsWith("-") || BODY_FLAGS.has(args[i - 1] ?? "")),
  );
}

function apiPositionals(args: readonly string[]): string[] {
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i] ?? "";
    if (API_FLAGS_WITH_VALUE.has(token)) i += 1;
    else if (!token.startsWith("-")) positionals.push(token);
  }
  return positionals;
}

function apiMergeAttempt(args: readonly string[]): MergeAttempt | undefined {
  const endpoint = apiPositionals(args)[0];
  if (endpoint === undefined) return undefined;
  const full = MERGE_PATH.exec(endpoint);
  if (full?.[1] !== undefined && full[2] !== undefined) return { ref: full[2], repo: full[1] };
  const short = SHORT_MERGE_PATH.exec(endpoint);
  if (short?.[1] !== undefined) return { ref: short[1], repo: undefined };
  return undefined;
}

type MergeDetection =
  | { readonly kind: "none" }
  | { readonly kind: "graphql" }
  | { readonly kind: "merge"; readonly attempts: readonly MergeAttempt[] };

function detectMerge(command: string): MergeDetection {
  const attempts: MergeAttempt[] = [];
  for (const match of command.matchAll(GH_PR_MERGE)) {
    const rest = command.slice(match.index + match[0].length);
    attempts.push(prMergeAttempt(tokenize(rest)));
  }
  for (const match of command.matchAll(GH_API)) {
    const rest = command.slice(match.index + match[0].length);
    const args = tokenize(rest);
    if (carriesGraphqlMerge(args)) return { kind: "graphql" };
    const attempt = apiMergeAttempt(args);
    if (attempt !== undefined) attempts.push(attempt);
  }
  return attempts.length === 0 ? { kind: "none" } : { kind: "merge", attempts };
}

function gh(args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "gh",
      [...args],
      { encoding: "utf8", timeout: LOOKUP_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
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
    const parsed: unknown = JSON.parse(await gh(args));
    if (typeof parsed !== "object" || parsed === null) throw new Error("unexpected output");
    const view: Record<string, unknown> = Object.fromEntries(Object.entries(parsed));
    sha = text(view["headRefOid"]);
    red = redChecks(view["statusCheckRollup"]);
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    return `refused: could not look up the PR's checks (${why}). A merge is allowed only when every check on the head commit is known to be green. Fix the lookup or report blocked.`;
  }
  if (red.length === 0) return undefined;
  return `refused: not every check on the PR's head commit${sha === "" ? "" : ` ${sha.slice(0, 12)}`} has passed:\n${red.map((line) => `- ${line}`).join("\n")}\nWait until all are green (run the wait with run_long, and gate it on the final state of every check), then merge again. --admin and --auto do not bypass this.`;
}

export async function mergeReason(command: string): Promise<string | undefined> {
  const detection = detectMerge(command);
  if (detection.kind === "none") return undefined;
  if (detection.kind === "graphql") return MERGE_GRAPHQL_REASON;
  for (const attempt of detection.attempts) {
    const reason = await attemptReason(attempt);
    if (reason !== undefined) return reason;
  }
  return undefined;
}
