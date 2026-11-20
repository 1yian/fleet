const COOKIE_HEADER = /(?<![\w-])(?:set-)?cookie2?(?:\\?["'])?\s*:/i;
const UNICODE_ESCAPE = /\\+u([\da-f]{4})/gi;

export function logicalView(text: string): string {
  return text.replace(/\\(?:\\|(\r?\n))/g, (pair, newline: unknown) =>
    typeof newline === "string" ? "" : pair,
  );
}

export const hasCookieHeader = (text: string): boolean =>
  COOKIE_HEADER.test(
    text.replace(UNICODE_ESCAPE, (_escape, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    ),
  );
