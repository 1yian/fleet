const CODED_REASONS: readonly (readonly [string, string])[] = [
  ["payment required", "402"],
  ["internal server error", "500"],
  ["bad gateway", "502"],
  ["gateway timeout", "504"],
];

const STATUS_LINE = /^HTTP\/\d(?:\.\d)?[ \t]+(\d{3})(?:[ \t]+([^\r\n]*))?(?=\r?\n)/i;

export const VERSIONED_ENVELOPE = {
  exec(source: string): (string | undefined)[] | null {
    const found = STATUS_LINE.exec(source);
    if (found === null) return null;
    const [line = "", status = "", reason = ""] = found;
    const lowered = reason.toLowerCase();
    const mismatched = CODED_REASONS.some(
      ([text, code]) => lowered.startsWith(text) && code !== status,
    );
    return mismatched ? null : [line, status];
  },
};
