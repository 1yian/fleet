import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

export interface ModelRef {
  readonly provider: string;
  readonly id: string;
}

export interface Compactor {
  readonly chain: readonly ModelRef[];
  readonly vertexOnly: boolean;
}

const VERTEX_PROVIDER = "google-vertex";
const CNP_CHAIN: readonly ModelRef[] = [
  { provider: "vertex-claude", id: "claude-haiku-5-5" },
  { provider: VERTEX_PROVIDER, id: "gemini-3.8-flash" },
];
const TIER_COMPACTOR: ModelRef = { provider: "tier", id: "compact" };
const CNP_RULE = "cnp";

function under(folder: string, child: string): boolean {
  const path = relative(folder, resolve(child));
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function isCnp(session: ModelRef, cwd: string, env: NodeJS.ProcessEnv): boolean {
  return (
    session.provider === VERTEX_PROVIDER ||
    env["PI_TIERS_RULE"] === CNP_RULE ||
    under(join(homedir(), "cnp"), cwd)
  );
}

export function compactorFor(session: ModelRef, cwd: string, env: NodeJS.ProcessEnv): Compactor {
  return isCnp(session, cwd, env)
    ? { chain: CNP_CHAIN, vertexOnly: true }
    : { chain: [TIER_COMPACTOR], vertexOnly: false };
}

export function firstAvailable<T>(
  compactor: Compactor,
  find: (model: ModelRef) => T | undefined,
): { readonly model: ModelRef; readonly found: T } | undefined {
  for (const model of compactor.chain) {
    const found = find(model);
    if (found !== undefined) return { model, found };
  }
  return undefined;
}

export function chainLabel(compactor: Compactor): string {
  return compactor.chain.map((model) => `${model.provider}/${model.id}`).join(" then ");
}
