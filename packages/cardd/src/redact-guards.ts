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
const ESCAPED_KEY = /\\?["']((?:[^"'\\\n]|\\+u[\da-f]{4})+)\\?["']\s*:/gi;
const KEY_ESCAPE = /\\+u([\da-f]{4})/gi;
const CREDENTIAL_KEY = new RegExp(String.raw`^${SECRET_NAME}$`, "i");
const UNICODE_ESCAPE = /\\+u([\da-f]{4})/gi;
const CONTROL_ESCAPE = /\\+[rntbf]/g;

export function normalizeInput(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/^\uFEFF/gm, "");
}

export function logicalView(text: string): string {
  return text.replace(/\\(?:\\|(\r?\n))/g, (pair, newline: unknown) =>
    typeof newline === "string" ? "" : pair,
  );
}

const TRACE_ROW = new RegExp(
  String.raw`(?:^|[\n\u0001"'\u0060])[ \t>*+-]*(?:\d{2}:\d{2}:\d{2}(?:\.\d+)?[ \t]+)?([\da-f]{4}):[ \t]([^\n\u0001]*)`,
  "gi",
);
const HTTP_TEXT = /HTTP\/|^(?:GET|POST|PUT|DELETE|HEAD|OPTIONS|PATCH)\s|^[\w-]+:\s/i;
const BROWSER_USERINFO = /(?<![a-z\d+.-])(?:https?|wss?|ftp):\/*(?!\[hidden\]@)[^\s/?#@]*@/i;

export const hasBrowserUserinfo = (text: string): boolean =>
  BROWSER_USERINFO.test(text.replace(/[\t\n\r]/g, "").replace(/\\/g, "/"));

const decoded = (text: string): string =>
  text
    .replace(UNICODE_ESCAPE, (_escape, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return code < 0x20 ? "\u0001" : String.fromCharCode(code);
    })
    .replace(CONTROL_ESCAPE, "\u0001")
    .replace(/\\+/g, "");

function hasTraceRows(text: string): boolean {
  const rows = Array.from(text.matchAll(TRACE_ROW), (row) => ({
    offset: Number.parseInt(row[1] ?? "", 16),
    rest: row[2] ?? "",
  }));
  const rising =
    rows.length > 1 &&
    rows.every((row, at) => at === 0 || row.offset > (rows[at - 1]?.offset ?? 0));
  return (
    rows.some((row) => row.offset === 0) || (rising && rows.some((row) => HTTP_TEXT.test(row.rest)))
  );
}

export const hasCookieHeader = (text: string): boolean => {
  const view = decoded(text);
  return COOKIE_HEADER.test(view) || hasTraceRows(view);
};

export const hasCookieRecord = (text: string): boolean =>
  [text, logicalView(text)].some(hasCookieHeader);

export function hasEscapedCredentialKey(text: string): boolean {
  for (const [, key = ""] of text.matchAll(ESCAPED_KEY)) {
    const decoded = key.replace(KEY_ESCAPE, (_escape, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    );
    if (decoded !== key && CREDENTIAL_KEY.test(decoded)) return true;
  }
  return false;
}
