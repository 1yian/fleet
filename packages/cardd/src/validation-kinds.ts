export type ValidationClass = "quota" | "daemon-down" | "refusal" | "other";

const DAEMON =
  /daemon (is )?(shutting down|crashed|not running|down|unavailable)|start daemon|connect to daemon|subscribe .*reconnect|econnrefused|connection refused|no-mistakes\.sock|daemon\.sock/i;
const QUOTA =
  /usage limit|quota|payment required|\b402\b|\b429\b|rate.?limit|no usable model|cooling|credit|billing|insufficient|overloaded/i;
const REFUSAL =
  /\brefus|attestation|post-review tree|diverged|pr body|body over budget|did not settle/i;

export function classifyRun(state: string, error: string): ValidationClass {
  if (state === "unavailable" || DAEMON.test(error)) return "daemon-down";
  if (QUOTA.test(error)) return "quota";
  if (REFUSAL.test(error)) return "refusal";
  return "other";
}
