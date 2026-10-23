import type { Timings } from "./timing.ts";

const MAX_RETRIES = 2;
const MAX_REPLACEMENTS = 1;

export type Phase = "turn" | "compaction" | "startup" | "lost";
export type Mode = "retry" | "replace";
export type Kind =
  "stale-module" | "router-cooldown" | "vendor-quota" | "auth" | "transient" | "unknown";

const SECRET_PATTERNS: readonly RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\b(sk|pk|xai|gsk|ghp|gho|github_pat)[-_][A-Za-z0-9_-]{8,}/g,
  /\b(api[-_ ]?key|token|secret|password|authorization)(["']?\s*[:=]\s*)["']?[^\s"',;]+/gi,
  /--fleet-token\W+[^\s'"]+/g,
  /\b[A-Za-z0-9_-]{32,}\b/g,
];
const ERROR_LIMIT = 600;

export function sanitize(text: string): string {
  const hidden = SECRET_PATTERNS.reduce(
    (out, pattern) =>
      out.replace(pattern, (_all, name: unknown, sep: unknown) =>
        typeof name === "string" && typeof sep === "string" ? `${name}${sep}[hidden]` : "[hidden]",
      ),
    text,
  );
  const squashed = hidden.replace(/\s+/g, " ").trim();
  return squashed.length > ERROR_LIMIT ? `${squashed.slice(0, ERROR_LIMIT)}...` : squashed;
}

const SECONDS = 1000;

function retryAfterMs(error: string): number | undefined {
  const named = /retry[-_ ]after\D{0,12}(\d+(?:\.\d+)?)/i.exec(error);
  const within = /retry (?:again )?in (\d+(?:\.\d+)?) ?s/i.exec(error);
  const seconds = named?.[1] ?? within?.[1];
  return seconds === undefined ? undefined : Math.ceil(Number(seconds) * SECONDS);
}

const KINDS: readonly (readonly [Kind, RegExp])[] = [
  [
    "stale-module",
    /cannot find (module|package)|ERR_MODULE_NOT_FOUND|failed to load url|does not provide an export/i,
  ],
  [
    "router-cooldown",
    /no usable model for tier|no model is available for tier|every model is cooling|all candidates (are )?excluded|cooldown/i,
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

export function classify(error: string): Kind {
  return KINDS.find(([, pattern]) => pattern.test(error))?.[0] ?? "unknown";
}

const DELAYED: ReadonlySet<Kind> = new Set(["transient", "router-cooldown"]);

export function eligibleAt(
  kind: Kind,
  error: string,
  retries: number,
  now: number,
  t: Timings,
  routerResumeAt?: number,
): number | null {
  const after = retryAfterMs(error);
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

function modesFor(phase: Phase, kind: Kind, eligible: number | null): Mode[] {
  if (phase === "startup" || phase === "lost") return ["replace"];
  if (kind === "stale-module") return ["replace"];
  if (kind === "router-cooldown" || kind === "transient") return ["retry"];
  if (kind === "vendor-quota") return eligible === null ? [] : ["retry"];
  if (kind === "auth") return [];
  return ["retry", "replace"];
}

export function remaining(inc: {
  readonly phase: Phase;
  readonly classification: Kind;
  readonly eligibleAt: number | null;
  readonly retries: number;
  readonly replacements: number;
}): Mode[] {
  return modesFor(inc.phase, inc.classification, inc.eligibleAt).filter((mode) =>
    mode === "retry" ? inc.retries < MAX_RETRIES : inc.replacements < MAX_REPLACEMENTS,
  );
}
