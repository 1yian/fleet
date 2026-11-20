export const SECRET_NAME = String.raw`(?:[a-z\d]+[-_])*(?:api[-_ ]?key|secret[-_ ]?access[-_ ]?key|(?:(?:access|refresh|session)[-_ ]?)?token|(?:client[-_ ]?)?secret|password|authorization)`;
const RECORD_NAME = String.raw`(?:${SECRET_NAME}|(?:proxy-)?authorization|(?:set-)?cookies?2?)`;
const COOKIE_HEADER = new RegExp(
  [
    String.raw`(?<![\w-])(?:set-)?cookies?2?(?:\\?["'])?\s*:`,
    String.raw`["']name["']\s*:\s*["']${RECORD_NAME}["']`,
    String.raw`\[\s*["']${RECORD_NAME}["']\s*,\s*["']`,
    String.raw`[\u0001<>]\s*${RECORD_NAME}\s*:`,
    String.raw`\]\s*\[\s*${RECORD_NAME}\s*:`,
    String.raw`[:,\[{]\s*["']\s*${RECORD_NAME}\s*:`,
    String.raw`(?<![a-z\d])authorization["']?\s*[:=]\s*(?!(?:Basic|Bearer)\b|\[hidden\])[a-z][\w.-]*[ \t]+\S`,
  ].join("|"),
  "i",
);
const UNICODE_ESCAPE = /\\+u([\da-f]{4})/gi;
const CONTROL_ESCAPE = /\\+[rntbf]/g;

export function logicalView(text: string): string {
  return text.replace(/\\(?:\\|(\r?\n))/g, (pair, newline: unknown) =>
    typeof newline === "string" ? "" : pair,
  );
}

export const hasCookieHeader = (text: string): boolean =>
  COOKIE_HEADER.test(
    text
      .replace(UNICODE_ESCAPE, (_escape, hex: string) => {
        const code = Number.parseInt(hex, 16);
        return code < 0x20 ? "\u0001" : String.fromCharCode(code);
      })
      .replace(CONTROL_ESCAPE, "\u0001")
      .replace(/\\+/g, ""),
  );

export const hasCookieRecord = (text: string): boolean =>
  [text, logicalView(text)].some(hasCookieHeader);
