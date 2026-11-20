import { isAbsolute } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { check, missingPersonalClone, OPS, PERSONAL_PROJECT } from "@fleet/protocol";
import { routed } from "@fleet/protocol/route";
import { runOnTransport } from "@fleet/protocol/transport";
import { routeFor } from "./merged-report.ts";
import type { Hosts } from "./pulls.ts";
import { insertProjectIfMissing, mainLane, type Session } from "./store.ts";
import { listProjects } from "./projects.ts";

const HOST_DIR = "${FLEET_HOST_DIR:-$HOME/.fleet}";
const CLONE_SUFFIX = `/projects/${PERSONAL_PROJECT}`;
const CLONE_FRAME = "\u001efleet-personal-path\u001e";

const MAKE_CLONE_SCRIPT = `set -eu
clone=${HOST_DIR}${CLONE_SUFFIX}
case "$clone" in /*) ;; *) echo "the fleet host directory must be absolute" >&2; exit 1 ;; esac
parent=\${clone%/*}
marker=.git/fleet-personal-bootstrap
owned_empty_clone() {
  [ ! -L "$1" ] && [ -d "$1/.git" ] && [ ! -L "$1/.git" ] &&
  [ -f "$1/$marker" ] && [ ! -L "$1/$marker" ] &&
  root=$(cat "$1/$marker") &&
  branch=$(git -C "$1" symbolic-ref HEAD) && [ "$branch" = refs/heads/main ] &&
  history=$(git -C "$1" rev-list --parents HEAD) && [ "$root" = "$history" ] &&
  refs=$(git -C "$1" for-each-ref --format='%(refname) %(objectname)') && [ "$refs" = "refs/heads/main $root" ] &&
  top=$(git -C "$1" rev-parse --show-toplevel) &&
  worktrees=$(git -C "$1" worktree list --porcelain) && [ "$worktrees" = "worktree $top
HEAD $root
branch refs/heads/main" ] &&
  tree=$(git -C "$1" ls-tree HEAD) && [ -z "$tree" ] &&
  remotes=$(git -C "$1" remote) && [ -z "$remotes" ] &&
  changes=$(GIT_OPTIONAL_LOCKS=0 git -C "$1" -c core.fsmonitor=false status --porcelain --untracked-files=all --ignored) && [ -z "$changes" ]
}
if [ ! -e "$clone" ] && [ ! -L "$clone" ]; then
  mkdir -p "$parent"
  stage=$(mktemp -d "$parent/.personal.XXXXXX")
  trap 'rm -rf "$stage"' 0
  repo=$stage/${PERSONAL_PROJECT}
  git -c core.hooksPath=/dev/null init -q -b main "$repo"
  tree=$(git -C "$repo" mktree </dev/null)
  root=$(git -C "$repo" -c user.name=fleet -c user.email=fleet@localhost commit-tree --no-gpg-sign "$tree" -m "Start the ${PERSONAL_PROJECT} project")
  git -C "$repo" -c core.hooksPath=/dev/null update-ref refs/heads/main "$root"
  printf '%s\\n' "$root" > "$repo/$marker"
  if ! owned_empty_clone "$repo"; then
    echo "the staged personal bootstrap is not empty" >&2
    exit 1
  fi
  mv -n "$repo" "$parent/"
fi
if ! owned_empty_clone "$clone"; then
  echo "cannot bootstrap personal at $clone: existing directory is not an empty Fleet bootstrap" >&2
  exit 1
fi
printf '%s%s%s\\n' '${CLONE_FRAME}' "$clone" '${CLONE_FRAME}'`;

const MAKE_CLONE_TIMEOUT_MS = 60_000;

let writer: Promise<void> = Promise.resolve();

function framedClonePath(stdout: string): string | undefined {
  const fields = stdout.split(CLONE_FRAME);
  const clone = fields[1];
  if (fields.length !== 3 || clone === undefined || !isAbsolute(clone)) return undefined;
  if (!clone.endsWith(CLONE_SUFFIX) || ["\0", "\r", "\n"].some((ch) => clone.includes(ch)))
    return undefined;
  return clone;
}

function makeClone(route: readonly string[], host: string): Promise<string> {
  const [file = "sh", ...args] = routed(route, ["sh", "-c", MAKE_CLONE_SCRIPT]);
  return new Promise((resolve, reject) => {
    runOnTransport(file, args, { timeout: MAKE_CLONE_TIMEOUT_MS }, (error, out, err) => {
      if (error !== null) {
        reject(
          new Error(
            `making the ${PERSONAL_PROJECT} repository on ${host} failed: ${err.trim() || error.message}`,
          ),
        );
        return;
      }
      const clone = framedClonePath(out);
      if (clone === undefined)
        reject(new Error(`invalid ${PERSONAL_PROJECT} clone path from ${host}`));
      else resolve(clone);
    });
  });
}

function registeredOn(db: DatabaseSync, host: string): boolean {
  const found = listProjects(db).find(({ name }) => name === PERSONAL_PROJECT);
  if (found === undefined) return false;
  if (!found.clones.some((clone) => clone.host === host))
    throw missingPersonalClone(host, found.clones);
  return true;
}

export async function ensurePersonalProject(
  db: DatabaseSync,
  session: Session,
  hosts: Hosts,
  raw: unknown,
): Promise<void> {
  const { host } = check(OPS["project.personal"].args, raw);
  if (session.lane !== mainLane(db))
    throw new Error(
      `only main can create the ${PERSONAL_PROJECT} project. Ask main, or dispatch under an existing project with a clone on ${host}`,
    );
  if (host === "local")
    throw new Error(
      `no canonical host specified for ${PERSONAL_PROJECT}: use a host name instead of ${host}`,
    );
  const route = routeFor(hosts, host);
  const done = writer.then(async () => {
    if (registeredOn(db, host)) return;
    let clone: string;
    try {
      clone = await makeClone(route, host);
    } catch (error) {
      if (registeredOn(db, host)) return;
      throw error;
    }
    const inserted = insertProjectIfMissing(db, {
      name: PERSONAL_PROJECT,
      delivery: "local-only",
      clones: { [host]: clone },
      yolo: false,
      repo: null,
    });
    if (!inserted && !registeredOn(db, host))
      throw new Error(`project ${PERSONAL_PROJECT} was removed during bootstrap; dispatch again`);
  });
  writer = done.catch(() => undefined);
  return done;
}
