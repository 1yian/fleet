import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

export interface ModelRef {
  readonly provider: string;
  readonly id: string;
}

export interface Compactor {
  readonly model: ModelRef;
  readonly vertexOnly: boolean;
}

const VERTEX_PROVIDER = "google-vertex";
const VERTEX_COMPACTOR: ModelRef = { provider: VERTEX_PROVIDER, id: "gemini-2.5-flash" };
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
    ? { model: VERTEX_COMPACTOR, vertexOnly: true }
    : { model: TIER_COMPACTOR, vertexOnly: false };
}
