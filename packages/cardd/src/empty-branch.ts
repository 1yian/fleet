import { execFile } from "node:child_process";
import type { DatabaseSync } from "node:sqlite";
import { check, OPS } from "@fleet/protocol";
import { localLanding } from "./attempts.ts";
import { routeFor } from "./merged-report.ts";
import type { Hosts } from "./pulls.ts";
import { getCard, listProjects } from "./store.ts";

const CHECK_TIMEOUT_MS = 30_000;

const quote = (arg: string): string => `'${arg.replaceAll("'", `'\\''`)}'`;

const EMPTY_SCRIPT = `set -eu
wt=$1 base=$2
[ -d "$wt" ] || exit 1
origin=""
if git -C "$wt" rev-parse -q --verify "refs/remotes/origin/$base" >/dev/null; then origin="origin/$base"; fi
ahead=$(git -C "$wt" rev-list --count HEAD --not "$base" \${origin:+"$origin"})
dirty=$(git -C "$wt" status --porcelain | wc -l | tr -d ' ')
[ "$ahead" -eq 0 ] && [ "$dirty" -eq 0 ]`;

function run(hosts: Hosts, host: string, argv: readonly string[]): Promise<boolean> {
  const route = routeFor(hosts, host);
  const [file = "sh", ...args] =
    route.length === 0 ? [...argv] : [...route, argv.map(quote).join(" ")];
  return new Promise((resolve) => {
    execFile(file, args, { timeout: CHECK_TIMEOUT_MS }, (error) => {
      resolve(error === null);
    });
  });
}

function placeOf(
  db: DatabaseSync,
  id: number,
): { host: string; worktree: string; base: string } | undefined {
  const card = getCard(db, id);
  if (card.kind !== "ship" || card.delivery !== "local-only") return undefined;
  const local = localLanding(db, id);
  const attempt = db
    .prepare("SELECT host, n FROM attempts WHERE card = ? ORDER BY n DESC LIMIT 1")
    .get(id);
  const host = attempt?.["host"];
  const clone = listProjects(db)
    .find((each) => each.name === card.project)
    ?.clones.find((each) => each.host === host)?.path;
  if (local === undefined || typeof host !== "string" || clone === undefined) return undefined;
  const worktree = `${clone}.worktrees/c-${String(id)}-a${String(attempt?.["n"])}`;
  return { host, worktree, base: local.base };
}

export async function emptyLocalBranch(
  db: DatabaseSync,
  hosts: Hosts,
  id: number,
  raw: unknown,
): Promise<true | undefined> {
  const args = check(OPS.report.args, raw);
  if (args.status !== "done" || args.merged === true) return undefined;
  const place = placeOf(db, id);
  if (place === undefined) return undefined;
  try {
    const empty = await run(hosts, place.host, [
      "sh",
      "-c",
      EMPTY_SCRIPT,
      "empty",
      place.worktree,
      place.base,
    ]);
    return empty ? true : undefined;
  } catch {
    return undefined;
  }
}
