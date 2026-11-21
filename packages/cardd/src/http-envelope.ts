const CODED_REASONS: readonly (readonly [string, string])[] = [
  ["payment required", "402"],
  ["internal server error", "500"],
  ["bad gateway", "502"],
  ["gateway timeout", "504"],
];

const STATUS_LINE = /^HTTP\/\d(?:\.\d)?[ \t]+(\d{3})(?:[ \t]+([^\r\n]*))?(?=\r?\n)/i;

const INLINE_RETRY = /^(.*?)\.?[ \t]*Retry-After:[ \t]*(\d+(?:\.\d+)?)[ \t]*$/i;

const VERSIONED_ENVELOPE = {
  exec(source: string): (string | undefined)[] | null {
    const found = STATUS_LINE.exec(source);
    if (found === null) return null;
    const [line = "", status = "", reason = ""] = found;
    const hinted = INLINE_RETRY.exec(reason);
    const lowered = (hinted?.[1] ?? reason).toLowerCase().replace(/[.\s]+$/, "");
    const mismatched = CODED_REASONS.some(([text, code]) => lowered === text && code !== status);
    return mismatched ? null : [line, status, hinted?.[2]];
  },
};

const SECONDS = 1000;

export function retryAfterMs(error: string): number | undefined {
  const named =
    /(?:(["'])retry[-_ ]after\1[ \t]*:[ \t]*|\bretry[-_ ]after[ \t]*[:=]?[ \t]*)(["']?)(\d+(?:\.\d+)?)\2(?!\w|\.\d)/i.exec(
      error,
    );
  const within = /retry (?:again )?in (\d+(?:\.\d+)?) ?s/i.exec(error);
  return milliseconds(named?.[3] ?? within?.[1]);
}

export function milliseconds(seconds: string | undefined): number | undefined {
  const ms = Math.ceil(Number(seconds) * SECONDS);
  return Number.isSafeInteger(ms) && ms <= 8_640_000_000_000_000 - Date.now() ? ms : undefined;
}

const HTTP_REASON = String.raw`(?:too many requests|rate limit exceeded|overloaded|service unavailable|unauthorized|forbidden|(?<=\b402[ \t]+)payment required|(?<=\b500[ \t]+)internal server error|(?<=\b502[ \t]+)bad gateway|(?<=\b503[ \t]+)service temporarily unavailable|(?<=\b504[ \t]+)gateway timeout)`;
const HTTP_ENVELOPE = new RegExp(
  String.raw`^(?:HTTP(?:/\d(?:\.\d)?)?[ \t]+|(?=\d{3}[ \t]+${HTTP_REASON}\b))(\d{3})(?:[ \t]+${HTTP_REASON})?\.?[ \t]*(?:Retry-After:[ \t]*(\d+(?:\.\d+)?)[ \t]*)?(?=\r?\n|$)`,
  "i",
);

const INTERIM_STATUS = String.raw`(?:1(?!01)\d\d|2\d\d[ \t]+Connection established)`;
const INTERIM_LINE = new RegExp(String.raw`^HTTP\/\d(?:\.\d)?[ \t]+${INTERIM_STATUS}\b`, "i");
const INTERIM_BLOCK = new RegExp(
  String.raw`^HTTP\/\d(?:\.\d)?[ \t]+${INTERIM_STATUS}[^\r\n]*\r?\n(?:[!#$%&'*+.^_\u0060|~\w-]+:[^\r\n]*\r?\n)*\r?\n`,
  "i",
);

export interface Envelope {
  readonly status: string;
  readonly inline: string | undefined;
  readonly rest: string;
  readonly blocked: boolean;
}

function direct(source: string): Envelope | null {
  const found = HTTP_ENVELOPE.exec(source);
  const [line = "", status = "", inline] = found ?? VERSIONED_ENVELOPE.exec(source) ?? [];
  if (found === null && status === "") return null;
  return { status, inline, rest: source.slice(line.length), blocked: false };
}

const BLOCKED: Envelope = { status: "", inline: undefined, rest: "", blocked: true };

export const LEADING_ENVELOPE = {
  exec(source: string): Envelope | null {
    let rest = source;
    while (INTERIM_LINE.test(rest)) {
      const block = INTERIM_BLOCK.exec(rest)?.[0];
      if (block === undefined) return BLOCKED;
      rest = rest.slice(block.length);
    }
    const final = direct(rest);
    return rest === source || final !== null ? final : BLOCKED;
  },
};
