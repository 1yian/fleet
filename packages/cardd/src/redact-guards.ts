export const SECRET_NAME = String.raw`(?:[a-z\d]+[-_])*(?:api[-_ ]?key|secret[-_ ]?access[-_ ]?key|(?:(?:access|refresh|session)[-_ ]?)?token|(?:client[-_ ]?)?secret|password|authorization)`;
const RECORD_NAME = String.raw`(?:${SECRET_NAME}|(?:proxy-)?authorization|(?:set-)?cookies?2?)`;
const COOKIE_HEADER = new RegExp(
  [
    String.raw`(?<![\w-])(?:set-)?cookies?2?(?:\\?["'])?\s*:`,
    String.raw`["']name["']\s*:\s*["']${RECORD_NAME}["']`,
    String.raw`\[\s*["']${RECORD_NAME}["']\s*,\s*["']`,
    String.raw`[\u0001<>]\s*${RECORD_NAME}\s*:`,
    String.raw`\]\s*\[\s*${RECORD_NAME}\s*:`,
    String.raw`(?<![\w])[\da-f]{4}:[ \t](?:[\da-f]{2}[ \t]){4}`,
    String.raw`[:,\[{]\s*["']\s*${RECORD_NAME}\s*:`,
    String.raw`(?<![a-z\d])authorization["']?\s*[:=]\s*(?!(?:Basic|Bearer)\b|\[hidden\])[a-z][\w.-]*[ \t]+\S`,
  ].join("|"),
  "i",
);
const ESCAPED_KEY = /\\?["']((?:[^"'\\\n]|\\+[^\\\n])+)\\?["']\s*:/g;
const KEY_ESCAPE =
  /\\+(?:u\{([\da-fA-F]+)\}|u([\da-fA-F]{4})|x([\da-fA-F]{2})|U([\da-fA-F]{8})|[^\\\n])/g;
const CREDENTIAL_KEY = new RegExp(String.raw`^${SECRET_NAME}$`, "i");
const RECORD_KEY = new RegExp(String.raw`^${RECORD_NAME}$`, "i");
const RECORD_MENTION = new RegExp(String.raw`(?<![\w-])${RECORD_NAME}(?![\w-])`, "i");
const EXPLICIT_KEY = /(?:^|[{[,])[ \t]*(?:-[ \t]+)*\?(?=[ \t\n]|(?![\s\S]))/gm;
const DECORATED_KEY = new RegExp(
  String.raw`(?:^|[\s{\[,])(?:(?:!(?:<[^>\s]+>|[^\s,\[\]{}<>]*)|&[^\s,\[\]{}]+)\s+)+["']?${RECORD_NAME}["']?[ \t]*:`,
  "im",
);
const KEY_SPLICE = /\\+\n[ \t]*/g;
const UNICODE_ESCAPE = /\\+u([\da-f]{4})/gi;

export function normalizeInput(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/^\uFEFF/gm, "");
}

export function logicalView(text: string): string {
  return text.replace(/\\(?:\\|(\r?\n))/g, (pair, newline: unknown) =>
    typeof newline === "string" ? "" : pair,
  );
}

const TRACE_ROW = new RegExp(
  String.raw`(?:^|[\n\u0001"'\u0060])[ \t>*+-]*(?:(\d{2}:\d{2}:\d{2}(?:\.\d+)?)[ \t]+)?([\da-f]{4}):(?:[ \t]([^\n\u0001]*)|(?=[\n\u0001"'}\]]|$))`,
  "gi",
);
const FRAGMENT = /^\S*$/;
const HTTP_TEXT = /HTTP\/|^(?:GET|POST|PUT|DELETE|HEAD|OPTIONS|PATCH)\s|^[\w-]+:\s/i;
const BROWSER_USERINFO = /(?<![a-z\d+.-])(?:https?|wss?|ftp):\/*(?!\[hidden\]@)[^\s/?#@]*@/i;

export const hasBrowserUserinfo = (text: string): boolean =>
  BROWSER_USERINFO.test(
    text
      .replace(UNICODE_ESCAPE, (_escape, hex: string) =>
        String.fromCharCode(Number.parseInt(hex, 16)),
      )
      .replace(/[\t\n\r]/g, "")
      .replace(/\\/g, "/"),
  );

interface Decoded {
  readonly view: string;
  readonly starts: readonly number[];
  readonly literal: readonly boolean[];
}

const DECODE_TOKEN = /\\+(?:u([\da-fA-F]{4})|x([\da-fA-F]{2}))|(\\+[rntbf])|\\+|[\s\S]/g;

function decode(text: string): Decoded {
  let view = "";
  const starts: number[] = [];
  const literal: boolean[] = [];
  const emit = (char: string, start: number, plain: boolean): void => {
    view += char;
    starts.push(start);
    literal.push(plain);
  };
  for (const match of text.matchAll(DECODE_TOKEN)) {
    const [token = "", unicode, byte, control] = match;
    const start = match.index;
    const hex = unicode ?? byte;
    if (hex !== undefined) {
      const code = Number.parseInt(hex, 16);
      if (code < 0x20) emit("\u0001", start, false);
      else if (code !== 0x5c) emit(String.fromCharCode(code), start, false);
    } else if (control !== undefined) emit("\u0001", start, false);
    else if (!token.startsWith("\\")) emit(token, start, true);
  }
  return { view, starts, literal };
}

const decoded = (text: string): string => decode(text).view;

interface Row {
  readonly stamped: boolean;
  readonly offset: number;
  readonly rest: string;
}

function clippedAfter(prior: Row, row: Row): boolean {
  const gap = row.offset - prior.offset;
  const room = gap - prior.rest.length;
  const fragments = FRAGMENT.test(prior.rest.trim()) && FRAGMENT.test(row.rest.trim());
  const ended = row.rest.replace(/["'}\]\s]+$/, "") === "";
  const stamped =
    row.stamped && prior.stamped && (fragments || ended) && (room === 1 || room === 2);
  return (prior.rest.length === 64 && gap === 64) || stamped;
}

function hasTraceRows(text: string): boolean {
  const rows: Row[] = Array.from(text.matchAll(TRACE_ROW), (row) => ({
    stamped: row[1] !== undefined,
    offset: Number.parseInt(row[2] ?? "", 16),
    rest: (row[3] ?? "").replace(/\r$/, ""),
  }));
  const pairs = rows.flatMap((row, at) => {
    const prior = rows[at - 1];
    return prior === undefined ? [] : [[prior, row] as const];
  });
  const rising = pairs.length > 0 && pairs.every(([prior, row]) => row.offset > prior.offset);
  const http = rows.some((row) => HTTP_TEXT.test(row.rest));
  const clipped = pairs.some(([prior, row]) => clippedAfter(prior, row));
  return rows.some((row) => row.offset === 0) || clipped || (rising && http);
}

const hasCookieHeader = (text: string): boolean => {
  const view = decoded(text);
  return COOKIE_HEADER.test(view) || hasTraceRows(view);
};

export const hasCookieRecord = (text: string): boolean =>
  [text, logicalView(text)].some(hasCookieHeader);

function decodeKeyEscapes(key: string): string {
  return key.replace(KEY_ESCAPE, (_escape, ...groups: (string | undefined)[]) => {
    const hex = groups.slice(0, 4).find((group) => group !== undefined);
    if (hex === undefined) return "";
    const code = Number.parseInt(hex, 16);
    return code > 0x10ffff ? "" : String.fromCodePoint(code);
  });
}

export function hasEscapedCredentialKey(text: string): boolean {
  for (const [, key = ""] of text.matchAll(ESCAPED_KEY)) {
    const decoded = decodeKeyEscapes(key);
    if (decoded !== key && RECORD_KEY.test(decoded)) return true;
  }
  return false;
}

export function hasExplicitCredentialKey(text: string): boolean {
  for (const { index } of text.matchAll(EXPLICIT_KEY)) {
    const rest = decodeKeyEscapes(text.slice(index).replace(KEY_SPLICE, ""));
    if (RECORD_MENTION.test(rest)) return true;
  }
  return DECORATED_KEY.test(text);
}

const PARAM_NAME = new RegExp(String.raw`(?=[?&#;]([^=&#?;\n\u0001]*)=)`, "g");
const PERCENT = /%([\da-f]{2})/gi;

export function percentDecoded(name: string): string {
  let current = name.replaceAll("+", " ");
  for (let pass = 0; pass < 4; pass += 1) {
    const next = current.replace(PERCENT, (_all, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    );
    if (next === current) break;
    current = next;
  }
  return current;
}

function literalSpan(found: Decoded, from: number, length: number): boolean {
  const first = found.starts[from] ?? 0;
  for (let offset = 0; offset < length; offset += 1) {
    if (found.literal[from + offset] !== true) return false;
    if (found.starts[from + offset] !== first + offset) return false;
  }
  return true;
}

const BROWSER_IGNORED = new Set(["\t", "\n", "\r", "\u0001"]);
const URL_SCHEME = /(?<![a-z\d+.-])(?:https?|wss?|ftp):[/\\]*|[a-z][a-z\d+.-]*:\/\//gi;

function withoutBrowserWhitespace(found: Decoded): Decoded {
  const kept: number[] = [];
  for (let index = 0; index < found.view.length; index += 1) {
    if (!BROWSER_IGNORED.has(found.view[index] ?? "")) kept.push(index);
  }
  return {
    view: kept.map((index) => found.view[index]).join(""),
    starts: kept.map((index) => found.starts[index] ?? 0),
    literal: kept.map((index) => found.literal[index] === true),
  };
}

const VALUE_END = new RegExp(String.raw`[\s"'<>\u0060&#\u0001]`);
const VALUE_CORE = /^[\w~%+/=.-]*$/;
const VALUE_TAIL = /[.,;:!?]+$/;

function closesQuote(found: Decoded, index: number, quote: string): boolean {
  if (found.view[index] !== quote || found.literal[index] !== true) return false;
  return index === 0 || found.starts[index] === (found.starts[index - 1] ?? -2) + 1;
}

function closedBetween(found: Decoded, from: number, to: number, quote: string): boolean {
  for (let index = from; index < to; index += 1) {
    if (closesQuote(found, index, quote)) return true;
  }
  return false;
}

function urlContext(found: Decoded, at: number): { quote: string | undefined } | null {
  const starts = Array.from(found.view.slice(0, at).matchAll(URL_SCHEME), (m) => m.index);
  for (const start of starts.reverse()) {
    const opener = found.view[start - 1] ?? "";
    const quote = /["'\u0060]/.test(opener) ? opener : undefined;
    const open =
      quote === undefined
        ? !/\s/.test(found.view.slice(start, at))
        : !closedBetween(found, start, at, quote);
    if (open) return { quote };
  }
  return null;
}

function valueBoundary(found: Decoded, start: number, quote: string | undefined): number {
  if (quote === undefined) {
    const stop = found.view.slice(start).search(VALUE_END);
    return stop < 0 ? found.view.length : start + stop;
  }
  for (let index = start; index < found.view.length; index += 1) {
    if (closesQuote(found, index, quote) || "&#".includes(found.view[index] ?? "")) return index;
  }
  return found.view.length;
}

function unprovenValue(
  found: Decoded,
  match: RegExpExecArray,
  name: string,
  context: { quote: string | undefined } | null,
): boolean {
  const valueStart = match.index + name.length + 2;
  const valueEnd = context === null ? valueStart : valueBoundary(found, valueStart, context.quote);
  if (!literalSpan(found, match.index, valueEnd - match.index)) return true;
  return !VALUE_CORE.test(found.view.slice(valueStart, valueEnd).replace(VALUE_TAIL, ""));
}

function hasCredentialAssignment(found: Decoded, candidatesOnly: boolean): boolean {
  for (const match of found.view.matchAll(PARAM_NAME)) {
    const name = match[1] ?? "";
    const key = percentDecoded(name);
    if (!CREDENTIAL_KEY.test(key)) continue;
    const context = urlContext(found, match.index);
    if (candidatesOnly && context === null) continue;
    if (key !== name || unprovenValue(found, match, name, context)) return true;
  }
  return false;
}

export function hasEncodedCredentialParam(text: string): boolean {
  const found = decode(text);
  return (
    hasCredentialAssignment(found, false) ||
    hasCredentialAssignment(withoutBrowserWhitespace(found), true)
  );
}
