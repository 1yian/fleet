export interface ModelRef {
  readonly provider: string;
  readonly id: string;
}

const VERTEX_PROVIDER = "google-vertex";
const VERTEX_COMPACTOR: ModelRef = { provider: VERTEX_PROVIDER, id: "gemini-2.5-flash" };
const TIER_COMPACTOR: ModelRef = { provider: "tier", id: "compact" };

export function compactionModelFor(session: ModelRef): ModelRef {
  return session.provider === VERTEX_PROVIDER ? VERTEX_COMPACTOR : TIER_COMPACTOR;
}
