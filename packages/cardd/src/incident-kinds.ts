import { CURL_DATA_SECRET, CURL_SHELL_EXPANSION } from "./curl-shell.ts";
import { VERSIONED_ENVELOPE } from "./http-envelope.ts";
import {
  hasBrowserUserinfo,
  hasCookieRecord,
  hasEncodedCredentialParam,
  hasEscapedCredentialKey,
  logicalView,
  normalizeInput,
  SECRET_NAME,
} from "./redact-guards.ts";
import type { Timings } from "./timing.ts";

const MAX_RETRIES = 2;
const MAX_REPLACEMENTS = 1;

export type Phase = "turn" | "compaction" | "startup" | "lost";
export type Mode = "retry" | "replace";
export type Kind =
  | "stale-module"
  | "router-cooldown"
  | "vendor-quota"
  | "auth"
  | "transient"
  | "withheld"
  | "unknown";

const SECRET_KEY = String.raw`\b(${SECRET_NAME})`;
const QUOTED = String.raw`\\"(?:\\\\(?:\\["\\]|[^"\\])|[^"\\])*\\"|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|(?<!\u0060)(?<ticks>\u0060+)(?!\u0060)[\s\S]*?(?<!\u0060)\k<ticks>(?!\u0060)`;
const LINE_SPLICE = String.raw`(?:\\\r?\n)*`;
const AUTH_WORD = ["Basic", "Bearer"].map((word) => Array.from(word).join(LINE_SPLICE)).join("|");
const AUTH_SCHEME = String.raw`(?<=(?:\b|[-_])authorization(?:\\?["'])?\s*[:=]\s*)(?:\\\r?\n[ \t]*)*(?:${AUTH_WORD})${LINE_SPLICE}\s+`;
const HIDDEN_MARKER = String.raw`(?-i:\[hidden\])(?=$|[\s"',;)\]}]|[.!?](?=\s|$))`;
const STRUCTURED_VALUE = String.raw`${AUTH_SCHEME}[A-Za-z0-9._~+/=-]+|(?:${AUTH_SCHEME})?(?:${QUOTED})|${HIDDEN_MARKER}|[^\s"',;]+`;
const SHELL_VALUE = String.raw`(?:${AUTH_SCHEME})?(?:${QUOTED}|\\[^\r\n]|(?![,.;](?=\s|$)|\]\()[^\s"'\\])+`;
const SHELL_SECRET = new RegExp(
  String.raw`(?:${SECRET_KEY}(\s*=\s*)|--fleet-token(?:\s*[:=]\s*|\s+))${SHELL_VALUE}`,
  "gi",
);
const CURL_WITHHELD = "[curl withheld: credential boundaries unclear]";
const CURL_COMMAND = /(?<![\w-])curl(?![\w.-])/i;
const CURL_CREDENTIAL_OPTION =
  /(?<=\s)(?:--(?:proxy-)?user(?![\w-])|--oauth2-bearer(?![\w-])|--cookie(?![\w-])|--(?:proxy-)?(?:pass|tlspassword|cert)(?![\w-])|-[^-\s]*[uUbE])/;
const CURL_CREDENTIAL_HEADER = new RegExp(
  String.raw`(?<=\s)(?:--header[=\s]\s*|-[^-\s]*H\s*)(?:${SECRET_NAME}|(?:set-)?cookie2?)\s*:`,
  "i",
);
const CURL_PROVEN_HEADER = new RegExp(
  String.raw`(?<=\s)(?:-H|--header)[ =]\s*(["'])authorization\s*:\s*(?:${AUTH_WORD})${LINE_SPLICE}\s+[A-Za-z0-9._~+/=-]+\1(?=\s|$)`,
  "gi",
);
const CURL_PROXY_LOGIN = /(?<=\s)(?:--(?:pre)?proxy|--socks|-[^-\s]*x\s*\S*@)/;
const CURL_UNPROVEN_USERINFO = /(?<=\s)[^\s@/]+:[^\s@/]*@/;
const CURL_CHECKS = [
  CURL_CREDENTIAL_OPTION,
  CURL_CREDENTIAL_HEADER,
  CURL_PROXY_LOGIN,
  CURL_UNPROVEN_USERINFO,
  CURL_DATA_SECRET,
];
const YAML_KEY = String.raw`((?<yamlQuote>["']?)${SECRET_NAME}\k<yamlQuote>)[ \t]*:`;
const YAML_SCALAR_LINE = String.raw`[^\r\n]+?(?=(?<![ \t])[ \t]+#|$)`;
const YAML_SCALAR_INDENT = String.raw`\2 +(?![\s#]|-(?:[ \t]|$)|(?:(?![ \t]#)[^\r\n])*:(?:[ \t]|$))`;
const YAML_BEFORE_VALUE = String.raw`(?:[ \t]+#[^\r\n]*|[ \t]*)\r?\n(?:[ \t]*(?:#[^\r\n]*)?\r?\n)*`;
const YAML_CONTINUATION = String.raw`\r?\n(?: *\r?\n)*${YAML_SCALAR_INDENT}${YAML_SCALAR_LINE}`;
const YAML_TAG = String.raw`!(?:<[^>\s]+>|[^\s,\[\]{}<>]*)`;
const yamlSingleQuoted = (lineBreak: string): string => String.raw`'(?:''|[^'\r\n]|${lineBreak})*'`;
const yamlDoubleQuoted = (lineBreak: string): string =>
  String.raw`"(?:\\(?:[^\r\n]|${lineBreak})|[^"\\\r\n]|${lineBreak})*"`;
const YAML_FLOW_BREAK = String.raw`\r?\n`;
const YAML_FLOW_SINGLE_QUOTED = yamlSingleQuoted(YAML_FLOW_BREAK);
const YAML_FLOW_PLAIN = String.raw`(?![\s'"!&*|>%@\u0060#])(?:[^,\[\]{}:#\r\n]|:(?![\s,\[\]{}]|$)|(?<!\s)#|\r?\n(?![ \t]*#))+?`;
const YAML_FLOW_SPACE = String.raw`(?:[ \t]+|${YAML_BEFORE_VALUE}[ \t]*)`;
const YAML_ALIAS =
  /(?:^|[[{,]|:(?=\s)|["']:)[ \t]*(?:(?:[-?]|---)[ \t]+)*\*[^\s,[\]{}'"*]+?(?=[ \t]*(?:[,}\]]|[ \t]#|\r?$|:\s))/m;
const YAML_MERGE_KEY = /(?:^|[[{,])[ \t]*(?:[-?][ \t]+)*(?:<<|"<<"|'<<')[ \t]*(?::|\r?$)/m;
const YAML_BLOCK_MARKER = String.raw`[|>]([+-]?[1-9]|[1-9][+-]?|[+-])?(?:[ \t]+#[^\r\n]*)?[ \t]*(?=\r?\n|$)`;
const YAML_UNBOUNDED_SECRET = new RegExp(
  String.raw`(?<![\w-])${YAML_KEY}${YAML_FLOW_SPACE}?(?:${YAML_TAG}|[&*][^\s,\[\]{}]+|${YAML_BLOCK_MARKER})`,
  "gi",
);
const YAML_NESTED_SECRET = new RegExp(String.raw`^ *(?:-[ \t]+){2,}${YAML_KEY}`, "gim");
const FLOW_CREDENTIAL_COLLECTION = new RegExp(
  String.raw`(?<![\w-])(?:${YAML_KEY}|${SECRET_KEY}\\["'][ \t]*:)${YAML_FLOW_SPACE}?(?!${HIDDEN_MARKER})[\[{]`,
  "gi",
);
const BLOCK_CREDENTIAL_COLLECTION = new RegExp(
  String.raw`^( *)(?:- +)?${YAML_KEY}${YAML_BEFORE_VALUE}\1(?: *-(?=[ \t]|$)| +(?:\?(?=[ \t]|$)|(?:"(?:\\[^\r\n]|[^"\\\r\n])*"|'(?:''|[^'\r\n])*'|[^\s'"#|>{\[][^:\r\n]*):(?=[ \t]|$)))`,
  "gim",
);
const YAML_FLOW_UNBOUNDED_PLAIN = new RegExp(
  String.raw`(?<=[{\[,]${YAML_FLOW_SPACE}?)${YAML_KEY}${YAML_FLOW_SPACE}?(?!['"\u0060])[^\s,\[\]{}]+\s+[^\s,\[\]{}#]`,
  "gi",
);
const RECORD_WITHHELD = "[credential record withheld: credential boundaries unclear]";
const YAML_WITHHELD = "[YAML withheld: credential boundaries unclear]";
const YAML_FLOW_VALUE = String.raw`(?:${YAML_TAG}${YAML_FLOW_SPACE}(?:${YAML_FLOW_SINGLE_QUOTED}|${yamlDoubleQuoted(YAML_FLOW_BREAK)}|${YAML_FLOW_PLAIN})|${YAML_FLOW_SINGLE_QUOTED})`;
const YAML_FLOW_SECRET = new RegExp(
  String.raw`(?<=[{\[,]${YAML_FLOW_SPACE}?)${YAML_KEY}${YAML_FLOW_SPACE}?${YAML_FLOW_VALUE}(?=${YAML_FLOW_SPACE}?[,}\]])`,
  "gi",
);
const YAML_BLOCK_BREAK = String.raw`\r?\n(?: *\r?\n)*\2 +(?=[^ \r\n])`;
const YAML_BLOCK_END = String.raw`(?=[ \t]*(?:[ \t]#|$))`;
const YAML_BLOCK_SINGLE_QUOTED = `${yamlSingleQuoted(YAML_BLOCK_BREAK)}${YAML_BLOCK_END}`;
const YAML_BLOCK_PLAIN = String.raw`(?!(?:\\?["'\u0060]|[\s#{\[!&*]|[|>][-+\d]*(?=[ \t]|$)))${YAML_SCALAR_LINE}(?:${YAML_CONTINUATION})*`;
const yamlBlockSpace = (indent: string): string =>
  String.raw`(?:[ \t]+|${YAML_BEFORE_VALUE}${indent} +)`;
const YAML_BLOCK_SPACE = yamlBlockSpace(String.raw`\2`);
const YAML_TAGGED_SCALAR = String.raw`${YAML_TAG}${YAML_BLOCK_SPACE}(?:${YAML_BLOCK_SINGLE_QUOTED}|${yamlDoubleQuoted(YAML_BLOCK_BREAK)}${YAML_BLOCK_END}|${YAML_BLOCK_PLAIN})`;
const AUTH_HEADER = String.raw`(?![^\r\n]*\\\r?\n *(?:- +)?[^\s:]+:(?:[ \t]|$))${AUTH_SCHEME}`;
const YAML_SECRET = new RegExp(
  String.raw`^(( *)(?:- +)?)${YAML_KEY}(?:${YAML_BLOCK_SPACE}(?:${YAML_TAGGED_SCALAR}|${YAML_BLOCK_SINGLE_QUOTED})|(?:[ \t]+(?!${AUTH_HEADER})|${YAML_BEFORE_VALUE}${YAML_SCALAR_INDENT})${YAML_BLOCK_PLAIN})`,
  "gim",
);
const YAML_HEADER_SPACE = yamlBlockSpace("");
const YAML_BLOCK_HEADER = new RegExp(
  String.raw`^( *(?:- +)?)${YAML_KEY}${YAML_HEADER_SPACE}(?:${YAML_TAG}${YAML_HEADER_SPACE})?${YAML_BLOCK_MARKER}`,
  "gim",
);
const STRUCTURED_SECRET = new RegExp(
  String.raw`${SECRET_KEY}((?:\\?["']\s*[:=]|\s*:)\s*)(?:${STRUCTURED_VALUE})|\bBearer\s+[A-Za-z0-9._~+/=-]+`,
  "gi",
);
const OPENING_QUOTE = new RegExp(
  String.raw`${SECRET_KEY}(?:\\?["']\s*[:=]|\s*[:=])\s*\\?["'\u0060]|--fleet-token(?:\s*[:=]\s*|\s+)["'\u0060]`,
  "gi",
);
const QUOTED_VALUE = new RegExp(QUOTED, "y");
const QUOTED_SPANS = new RegExp(QUOTED, "g");
const URL_WITHHELD = "[URL withheld: credential boundaries unclear]";
const URL_AUTHORITY =
  /(?<=(?:[a-z0-9+.-]|\\+u[\da-f]{4})+(?::|\\+u003a)(?:(?:\\?\/|\\+u002f)){1,3})(?:[^\s/\\?#]|\\(?!\/|u00(?:2f|3f|23))(?:u[\da-f]{4}|["\\bfnrt])?)+/gi;
const URL_AUTHORITY_TOKEN = /\\(?:u[\da-f]{4}|["\\bfnrt])|\\|"[,\]}]|@/gi;
const SECRET_PATTERNS: readonly RegExp[] = [
  /(?:"(?:\\[^\r\n]|[^"\\\r\n])*"|(?<![\p{L}\p{M}\p{N}.!#$%&'*+/=?^_`{|}~-])[\p{L}\p{M}\p{N}.!#$%&'*+/=?^_`{|}~-]+)@(?:[\p{L}\p{M}\p{N}-]+[.。．｡])+[\p{L}][\p{L}\p{M}\p{N}-]*/gu,
  /\b(sk|pk|xai|gsk|ghp|gho|ghs|ghu|ghr|github_pat|xox[abprs])[-_][A-Za-z0-9_-]{8,}/g,
  /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g,
];
const OPAQUE_VALUE =
  /\b(?:((?:revision|commit|git sha)(?:[ \t]*[:=][ \t]*|[ \t]+))[a-f\d]{40}(?:[a-f\d]{24})?(?![a-z\d_-])|[a-z\d_-]{32,}\b)/gi;
const ERROR_LIMIT = 600;

const hiddenValue = (_all: string, name: unknown, sep: unknown): string =>
  typeof name === "string" && typeof sep === "string" ? `${name}${sep}[hidden]` : "[hidden]";

function redactContinued(text: string, pattern: RegExp): string {
  const gaps: { at: number; width: number }[] = [];
  let removed = 0;
  const logical = text.replace(/\\(?:\\|(\r?\n))/g, (pair, newline: unknown, index: number) => {
    if (typeof newline !== "string") return pair;
    gaps.push({ at: index - removed, width: pair.length });
    removed += pair.length;
    return "";
  });
  if (gaps.length === 0) return text.replace(pattern, hiddenValue);

  let gapIndex = 0;
  let shift = 0;
  const sourceIndex = (at: number): number => {
    for (let gap = gaps[gapIndex]; gap !== undefined && gap.at <= at; gap = gaps[gapIndex]) {
      shift += gap.width;
      gapIndex += 1;
    }
    return at + shift;
  };
  let cursor = 0;
  let result = "";
  for (const match of logical.matchAll(pattern)) {
    result +=
      text.slice(cursor, sourceIndex(match.index)) + hiddenValue(match[0], match[1], match[2]);
    cursor = sourceIndex(match.index + match[0].length - 1) + 1;
  }
  return result + text.slice(cursor);
}

function yamlBlockEnd(text: string, start: number, keyIndent: number, modifiers: string): number {
  let indent = keyIndent + Number(modifiers.replace(/[+-]/g, ""));
  const line = /\r?\n( *)([^\r\n]*)/y;
  line.lastIndex = start;
  let end = start;
  for (let row = line.exec(text); row !== null; row = line.exec(text)) {
    const [, spaces = "", content = ""] = row;
    if (content.length === 0) continue;
    if (spaces.length <= keyIndent || spaces.length < indent) break;
    if (indent === keyIndent) indent = spaces.length;
    end = line.lastIndex;
  }
  return end;
}

function redactYamlBlocks(text: string): string {
  let cursor = 0;
  let result = "";
  for (const match of text.matchAll(YAML_BLOCK_HEADER)) {
    if (match.index < cursor) continue;
    const [header, prefix = "", key = "", , modifiers = ""] = match;
    result += `${text.slice(cursor, match.index)}${prefix}${key}: [hidden]`;
    cursor = yamlBlockEnd(text, match.index + header.length, prefix.length, modifiers);
  }
  return result + text.slice(cursor);
}

function curlCredentialOption(text: string): boolean {
  const spliced = text.replace(CURL_PROVEN_HEADER, "").replace(/\\\n/g, "");
  const joined = spliced.replace(/['"\\`]/g, "");
  const start = joined.search(CURL_COMMAND);
  const command = joined.slice(start);
  return (
    start !== -1 &&
    (CURL_SHELL_EXPANSION.test(spliced) || CURL_CHECKS.some((check) => check.test(command)))
  );
}

function scanUrlUserinfo(text: string): { text: string; ambiguous: boolean; count: number } {
  let ambiguous = false;
  let count = 0;
  const redacted = text.replace(URL_AUTHORITY, (authority) => {
    let separator = -1;
    let uncertainBoundary = Infinity;
    for (const { 0: token, index } of authority.matchAll(URL_AUTHORITY_TOKEN)) {
      if (token === "\\" || token.startsWith('"'))
        uncertainBoundary = Math.min(uncertainBoundary, index);
      else if (token === "@" || token.toLowerCase() === "\\u0040") separator = index;
    }
    if (separator <= 0) return authority;
    count += 1;
    if (uncertainBoundary < separator) ambiguous = true;
    return `[hidden]${authority.slice(separator)}`;
  });
  return { text: redacted, ambiguous, count };
}

function redactUrlUserinfo(text: string): string {
  const found = scanUrlUserinfo(text);
  const joined = text.replace(/\\\n/g, "").replace(/['"`]/g, "");
  const browser = text.replace(/[\t\n\r]/g, "").replace(/\\/g, "/");
  const spliced = logicalView(found.text) !== scanUrlUserinfo(logicalView(text)).text;
  const hidden = [joined, browser].some((view) => scanUrlUserinfo(view).count > found.count);
  const leaked = hasBrowserUserinfo(found.text);
  return found.ambiguous || spliced || hidden || leaked ? URL_WITHHELD : found.text;
}

function endsAtOpeningQuote(logical: string, end: number): boolean {
  const quote = logical[end];
  if (quote !== '"' && quote !== "'") return false;
  if (logical[end - 1] === "\\") return true;
  const before = logical.slice(0, end).match(quote === '"' ? /(?<!\\)"/g : /(?<!\\)'/g);
  return (before?.length ?? 0) % 2 === 0;
}

function hasStrayBacktick(logical: string, start: number, end: number): boolean {
  const rest = logical.slice(start, end).replace(QUOTED_SPANS, "");
  const at = rest.indexOf("\u0060");
  const opened = (logical.slice(0, start).split("\u0060").length - 1) % 2 === 1;
  return at !== -1 && !(at === rest.length - 1 && opened);
}

function hasUnprovenValue(text: string): boolean {
  const logical = logicalView(text);
  for (const pattern of [SHELL_SECRET, STRUCTURED_SECRET]) {
    for (const match of logical.matchAll(pattern)) {
      const end = match.index + match[0].length;
      if (endsAtOpeningQuote(logical, end) || hasStrayBacktick(logical, match.index, end))
        return true;
    }
  }
  for (const match of logical.matchAll(OPENING_QUOTE)) {
    const last = match.index + match[0].length - 1;
    QUOTED_VALUE.lastIndex = logical[last - 1] === "\\" ? last - 1 : last;
    if (!QUOTED_VALUE.test(logical)) return true;
  }
  return false;
}

export function redact(text: string, scope: "public" | "diagnostic"): string {
  return redactNormalized(normalizeInput(text), scope);
}

function hasCredentialCollection(source: string): boolean {
  return (
    YAML_ALIAS.test(source) ||
    YAML_MERGE_KEY.test(source) ||
    source.search(YAML_NESTED_SECRET) !== -1 ||
    source.search(FLOW_CREDENTIAL_COLLECTION) !== -1 ||
    source.search(BLOCK_CREDENTIAL_COLLECTION) !== -1
  );
}

function hasUnboundedSecret(yaml: string): boolean {
  return yaml.search(YAML_UNBOUNDED_SECRET) !== -1 || yaml.search(YAML_FLOW_UNBOUNDED_PLAIN) !== -1;
}

function redactYamlScalars(text: string): string {
  return redactYamlBlocks(text)
    .replace(YAML_FLOW_SECRET, '$1: "[hidden]"')
    .replace(
      YAML_SECRET,
      (_match, prefix: string, _indent: string, key: string) => `${prefix}${key}: [hidden]`,
    );
}

const AUTHORIZATION_KEY = new RegExp(
  String.raw`(?<![\w-])${Array.from("authorization").join(LINE_SPLICE)}(?=(?:\\?["'])?\s*[:=]\s*(?:\\\r?\n[ \t]*)*(?:${AUTH_WORD})${LINE_SPLICE}\s+(?![^\n]*\n[ \t]+\S))`,
  "gi",
);
const SCHEME_CONTINUATION = new RegExp(
  String.raw`\b(?:[a-z\d]+[-_])*authorization(?:\\?["'])?[ \t]*[:=][ \t]*(?:${AUTH_WORD})[ \t]+[^\n]*\n[ \t]+(?![^\s:]+:(?:[ \t]|$))\S`,
  "i",
);
const neutralAuthorization = (text: string): string => text.replace(AUTHORIZATION_KEY, "x-auth");

function yamlSplicesDisagree(source: string): boolean {
  const logical = logicalView(source);
  if (logical === source) return false;
  const physical = logicalView(redactYamlScalars(neutralAuthorization(source)));
  return neutralAuthorization(physical) !== redactYamlScalars(neutralAuthorization(logical));
}

function withheldCommand(text: string): string | undefined {
  if (curlCredentialOption(text)) return CURL_WITHHELD;
  if ([text, logicalView(text)].some(hasEncodedCredentialParam)) return URL_WITHHELD;
  return undefined;
}

function redactNormalized(source: string, scope: "public" | "diagnostic"): string {
  const views = [source, logicalView(source)];
  const unclear = views.some((v) => hasCredentialCollection(v) || hasEscapedCredentialKey(v));
  if (unclear || yamlSplicesDisagree(source) || SCHEME_CONTINUATION.test(views[1] ?? ""))
    return YAML_WITHHELD;
  const yaml = redactYamlScalars(source);
  if ([yaml, logicalView(yaml)].some(hasUnboundedSecret)) return YAML_WITHHELD;
  const urls = redactUrlUserinfo(yaml);
  if (urls === URL_WITHHELD) return urls;
  const refused = withheldCommand(urls);
  if (refused) return refused;
  if (hasCookieRecord(urls)) return RECORD_WITHHELD;
  if (hasUnprovenValue(urls)) return YAML_WITHHELD;
  const structured = redactContinued(redactContinued(urls, SHELL_SECRET), STRUCTURED_SECRET);
  const hidden = SECRET_PATTERNS.reduce(
    (out, pattern) => out.replace(pattern, hiddenValue),
    structured,
  );
  return hidden
    .replace(OPAQUE_VALUE, (match, revision: unknown) => {
      if (typeof revision !== "string") return "[hidden]";
      return scope === "diagnostic" ? match : `${revision}[hidden]`;
    })
    .replace(/\s+/g, " ")
    .trim();
}

function clipDiagnostic(redacted: string): string {
  return redacted.length > ERROR_LIMIT ? `${redacted.slice(0, ERROR_LIMIT)}...` : redacted;
}

export function sanitize(text: string): string {
  return clipDiagnostic(redact(text, "diagnostic"));
}

const SECONDS = 1000;

function retryAfterMs(error: string): number | undefined {
  const named =
    /(?:(["'])retry[-_ ]after\1[ \t]*:[ \t]*|\bretry[-_ ]after[ \t]*[:=]?[ \t]*)(["']?)(\d+(?:\.\d+)?)\2(?!\w|\.\d)/i.exec(
      error,
    );
  const within = /retry (?:again )?in (\d+(?:\.\d+)?) ?s/i.exec(error);
  return milliseconds(named?.[3] ?? within?.[1]);
}

function milliseconds(seconds: string | undefined): number | undefined {
  const ms = Math.ceil(Number(seconds) * SECONDS);
  return Number.isSafeInteger(ms) && ms <= 8_640_000_000_000_000 - Date.now() ? ms : undefined;
}

const KINDS: readonly (readonly [Kind, RegExp])[] = [
  [
    "stale-module",
    /cannot find (module|package)|ERR_MODULE_NOT_FOUND|failed to load url|does not provide an export/i,
  ],
  [
    "router-cooldown",
    /no usable model for tier|no usable account for|no model is available for tier|every model is cooling|all candidates (are )?excluded|cooldown/i,
  ],
  [
    "vendor-quota",
    /quota|credit balance|insufficient (funds|credits)|billing|payment required|\b402\b|exceeded your current|usage limit/i,
  ],
  ["auth", /\b401\b|\b403\b|invalid api key|unauthori[sz]ed|authentication|permission denied/i],
  [
    "transient",
    /\b(429|500|502|503|504|529)\b|overloaded|rate.?limit|econnreset|etimedout|timed? ?out|socket hang up|temporarily|service unavailable/i,
  ],
];

export interface FailureSignals {
  readonly kind: Kind;
  readonly retryAfter: number | undefined;
}

const HTTP_REASON = String.raw`(?:too many requests|rate limit exceeded|overloaded|service unavailable|unauthorized|forbidden|(?<=\b402[ \t]+)payment required|(?<=\b500[ \t]+)internal server error|(?<=\b502[ \t]+)bad gateway|(?<=\b503[ \t]+)service temporarily unavailable|(?<=\b504[ \t]+)gateway timeout)`;
const HTTP_ENVELOPE = new RegExp(
  String.raw`^(?:HTTP(?:/\d(?:\.\d)?)?[ \t]+|(?=\d{3}[ \t]+${HTTP_REASON}\b))(\d{3})(?:[ \t]+${HTTP_REASON})?\.?[ \t]*(?:Retry-After:[ \t]*(\d+(?:\.\d+)?)[ \t]*)?(?=\r?\n|$)`,
  "i",
);

const HTTP_HEADERS = /^\n((?:[!#$%&'*+.^_\u0060|~\w-]+:[^\n]*\n)*)\n/;
const RETRY_HEADER = /^retry-after:[ \t]*(\d+(?:\.\d+)?)[ \t]*$/i;

function headerRetryAfter(source: string): string | undefined {
  const section = HTTP_HEADERS.exec(source)?.[1];
  if (section === undefined) return undefined;
  const hints = section.split("\n").filter((line) => /^retry-after:/i.test(line));
  const hint = hints[0];
  if (hints.length !== 1 || hint === undefined || !RETRY_HEADER.test(hint)) return undefined;
  return RETRY_HEADER.exec(redactNormalized(hint, "diagnostic"))?.[1];
}

export function diagnoseFailure(text: string): {
  readonly error: string;
  readonly signals: FailureSignals;
} {
  const source = normalizeInput(text);
  const diagnostic = redactNormalized(source, "diagnostic");
  const error = clipDiagnostic(diagnostic);
  const marked = [YAML_WITHHELD, URL_WITHHELD, CURL_WITHHELD, RECORD_WITHHELD].includes(diagnostic);
  if (marked) {
    const envelope = HTTP_ENVELOPE.exec(source) ?? VERSIONED_ENVELOPE.exec(source);
    const [line = "", status = "", inline] = envelope ?? [];
    const seconds =
      inline ?? (envelope === null ? undefined : headerRetryAfter(source.slice(line.length)));
    const kind = envelope === null ? "withheld" : classify(status);
    return { error, signals: { kind, retryAfter: milliseconds(seconds) } };
  }
  return { error, signals: { kind: classify(error), retryAfter: retryAfterMs(diagnostic) } };
}

function classify(text: string): Kind {
  return KINDS.find(([, pattern]) => pattern.test(text))?.[0] ?? "unknown";
}

const DELAYED: ReadonlySet<Kind> = new Set(["transient", "router-cooldown"]);

export function eligibleAt(
  kind: Kind,
  after: number | undefined,
  retries: number,
  now: number,
  t: Timings,
  routerResumeAt?: number,
): number | null {
  const known = kind === "router-cooldown" && routerResumeAt !== undefined;
  const base =
    DELAYED.has(kind) && !known
      ? (t.retryDelays[Math.min(retries, t.retryDelays.length - 1)] ?? 0)
      : 0;
  const at = Math.max(
    base > 0 ? now + base : 0,
    after === undefined ? 0 : now + after,
    known ? routerResumeAt : 0,
  );
  return at > 0 ? at : null;
}

function modesFor(phase: Phase, kind: Kind): Mode[] {
  if (phase === "startup" || phase === "lost") return ["replace"];
  if (kind === "stale-module") return ["replace"];
  if (kind === "router-cooldown" || kind === "transient") return ["retry"];
  if (kind === "vendor-quota") return ["replace"];
  if (kind === "auth" || kind === "withheld") return [];
  return ["retry", "replace"];
}

export function remaining(inc: {
  readonly phase: Phase;
  readonly classification: Kind;
  readonly eligibleAt: number | null;
  readonly retries: number;
  readonly replacements: number;
}): Mode[] {
  return modesFor(inc.phase, inc.classification).filter((mode) =>
    mode === "retry" ? inc.retries < MAX_RETRIES : inc.replacements < MAX_REPLACEMENTS,
  );
}

export function exhaustion(inc: {
  readonly phase: Phase;
  readonly classification: Kind;
  readonly retries: number;
  readonly replacements: number;
}): string {
  const modes = modesFor(inc.phase, inc.classification);
  if (modes.length === 0) return `restarting is not a repair for ${inc.classification}`;
  const spent = modes.map((mode) =>
    mode === "retry"
      ? `${String(inc.retries)} of ${String(MAX_RETRIES)} retries`
      : `${String(inc.replacements)} of ${String(MAX_REPLACEMENTS)} replacement`,
  );
  return `every recovery its class allows is spent (${spent.join(" and ")})`;
}
