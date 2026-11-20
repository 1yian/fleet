const COOKIE_HEADER = /(?<![\w-])(?:set-)?cookie2?(?:\\?["'])?\s*:\s*(?!\[hidden\])\S/i;

export function logicalView(text: string): string {
  return text.replace(/\\(?:\\|(\r?\n))/g, (pair, newline: unknown) =>
    typeof newline === "string" ? "" : pair,
  );
}

export const hasCookieHeader = (text: string): boolean => COOKIE_HEADER.test(text);
