import type { DatabaseSync } from "node:sqlite";
import { check, missingPersonalClone, OPS, PERSONAL_PROJECT } from "@fleet/protocol";
import { routed } from "@fleet/protocol/route";
import { runOnTransport } from "@fleet/protocol/transport";
import { routeFor } from "./merged-report.ts";
import type { Hosts } from "./pulls.ts";
import { addProject, listProjects, mainLane, type Session } from "./store.ts";

const HOST_DIR = "${FLEET_HOST_DIR:-$HOME/.fleet}";

const MAKE_CLONE_SCRIPT = `set -eu
clone=${HOST_DIR}/projects/${PERSONAL_PROJECT}
case "$clone" in /*) ;; *) echo "the fleet host directory must be absolute" >&2; exit 1 ;; esac
mkdir -p "\${clone%/*}"
if ! mkdir "$clone"; then
  echo "cannot create personal at $clone; dispatch never uses an existing directory" >&2
  exit 1
fi
git -C "$clone" init -q -b main
git -C "$clone" -c user.name=fleet -c user.email=fleet@localhost -c commit.gpgsign=false commit -q --allow-empty -m "Start the ${PERSONAL_PROJECT} project"
printf '%s\\n' "$clone"`;

const MAKE_CLONE_TIMEOUT_MS = 60_000;

let writer: Promise<void> = Promise.resolve();

function makeClone(route: readonly string[], host: string): Promise<string> {
  const [file = "sh", ...args] = routed(route, ["sh", "-c", MAKE_CLONE_SCRIPT]);
  return new Promise((resolve, reject) => {
    runOnTransport(file, args, { timeout: MAKE_CLONE_TIMEOUT_MS }, (error, out, err) => {
      if (error === null) resolve(out.trim());
      else
        reject(
          new Error(
            `making the ${PERSONAL_PROJECT} repository on ${host} failed: ${err.trim() || error.message}`,
          ),
        );
    });
  });
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
  if (host.toLowerCase() === "local")
    throw new Error(
      `no canonical host specified for ${PERSONAL_PROJECT}: use a host name instead of ${host}`,
    );
  const route = routeFor(hosts, host);
  const done = writer.then(async () => {
    const found = listProjects(db).find(({ name }) => name === PERSONAL_PROJECT);
    if (found !== undefined) {
      if (!found.clones.some((clone) => clone.host === host))
        throw missingPersonalClone(host, found.clones);
      return;
    }
    const clone = await makeClone(route, host);
    addProject(db, {
      name: PERSONAL_PROJECT,
      delivery: "local-only",
      clones: { [host]: clone },
      yolo: false,
      repo: null,
    });
  });
  writer = done.catch(() => undefined);
  return done;
}
