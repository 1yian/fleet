const RETENTION = { mate: "short", worker: "short" } as const;

export function applyCachePolicy(role: keyof typeof RETENTION): void {
  process.env["PI_CACHE_RETENTION"] = RETENTION[role];
}
