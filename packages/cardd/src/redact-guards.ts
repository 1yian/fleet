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
  String.raw`(?:^|[\n\u0001"'\u0060])[ \t>*+-]*(?:\d{2}:\d{2}:\d{2}(?:\.\d+)?[ \t]+)?([\da-f]{4}):[ \t]`,
  "gi",
);

const decoded = (text: string): string =>
  text
    .replace(UNICODE_ESCAPE, (_escape, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return code < 0x20 ? "\u0001" : String.fromCharCode(code);
    })
    .replace(CONTROL_ESCAPE, "\u0001")
    .replace(/\\+/g, "");

function hasTraceRows(text: string): boolean {
  const offsets = Array.from(text.matchAll(TRACE_ROW), (row) => row[1]?.toLowerCase());
  return offsets.length > 1 || offsets.includes("0000");
}

export const hasCookieHeader = (text: string): boolean => {
  const view = decoded(text);
  return COOKIE_HEADER.test(view) || hasTraceRows(view);
};

export const hasCookieRecord = (text: string): boolean =>
  [text, logicalView(text)].some(hasCookieHeader);
