import type { Costs } from "./lane-config.ts";

export function applyCachePolicy(role: "mate" | "worker", costs: Costs | undefined): void {
  process.env["PI_CACHE_RETENTION"] =
    role === "mate" ? (costs?.mateCacheRetention ?? "short") : "short";
}

export function applyTierPolicy(role: "mate" | "worker"): void {
  if (role === "worker") process.env["PI_TIERS_BACKGROUND"] = "1";
  else delete process.env["PI_TIERS_BACKGROUND"];
}
