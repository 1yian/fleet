import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { check, OPS, PERSONAL_PROJECT } from "@fleet/protocol";
import { routed } from "@fleet/protocol/route";
import { runOnTransport } from "@fleet/protocol/transport";
import { routeFor } from "./merged-report.ts";
import type { Hosts } from "./pulls.ts";
import { addProject, listProjects, mainLane, type Session } from "./store.ts";

const HOST_DIR = "${FLEET_HOST_DIR:-$HOME/.fleet}";

const MAKE_CLONE_SCRIPT = `set -eu
clone=${HOST_DIR}/projects/${PERSONAL_PROJECT}
mkdir -p "$clone"
[ -d "$clone/.git" ] || git -C "$clone" init -q -b main
git -C "$clone" rev-parse -q --verify HEAD >/dev/null ||
  git -C "$clone" -c user.name=fleet -c user.email=fleet@localhost -c commit.gpgsign=false commit -q --allow-empty -m "Start the ${PERSONAL_PROJECT} project"
printf '%s\\n' "$clone"`;

const MAKE_CLONE_TIMEOUT_MS = 60_000;

let writer: Promise<unknown> = Promise.resolve();

function alone<T>(work: () => Promise<T>): Promise<T> {
  const done = writer.then(work);
  writer = done.catch(() => undefined);
  return done;
}

function routesOf(db: DatabaseSync, lane: string): string[] {
  const home = db.prepare("SELECT home FROM lanes WHERE name = ?").get(lane)?.["home"];
  try {
    const config: unknown = JSON.parse(
      readFileSync(join(String(home), "config", "lane.json"), "utf8"),
    );
    const record = (value: unknown): value is Record<string, unknown> =>
      typeof value === "object" && value !== null && !Array.isArray(value);
    if (!record(config)) return [];
    const own = config["host"];
    return [
      ...(record(config["hosts"]) ? Object.keys(config["hosts"]) : []),
      ...(typeof own === "string" ? [own] : []),
    ];
  } catch {
    return [];
  }
}

function authorize(db: DatabaseSync, session: Session, host: string): void {
  if (session.lane === mainLane(db) || routesOf(db, session.lane).includes(host)) return;
  throw new Error(
    `lane ${session.lane} has no route to ${host} that cardd can verify, so main must make the ${PERSONAL_PROJECT} project there`,
  );
}

function needsClone(db: DatabaseSync, host: string): boolean {
  const found = listProjects(db).find(({ name }) => name === PERSONAL_PROJECT);
  if (found === undefined) return true;
  if (found.clones.some((clone) => clone.host === host)) return false;
  throw new Error(
    `project ${PERSONAL_PROJECT} is already registered without a clone on ${host}, and dispatch never changes a registered project: the administrator adds one with project clone ${PERSONAL_PROJECT} ${host}=<path>, or dispatches under a project that has a clone there`,
  );
}

function makeClone(hosts: Hosts, host: string): Promise<string> {
  const [file = "sh", ...args] = routed(routeFor(hosts, host), ["sh", "-c", MAKE_CLONE_SCRIPT]);
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

export async function makePersonalClone(
  db: DatabaseSync,
  session: Session,
  hosts: Hosts,
  raw: unknown,
): Promise<string | undefined> {
  const { host } = check(OPS["project.personal"].args, raw);
  authorize(db, session, host);
  if (!needsClone(db, host)) return undefined;
  return alone(() => makeClone(hosts, host));
}

export function registerPersonalProject(
  db: DatabaseSync,
  host: string,
  clone: string | undefined,
): void {
  if (!needsClone(db, host)) return;
  if (clone === undefined) throw new Error(`the ${PERSONAL_PROJECT} repository was not made`);
  addProject(db, {
    name: PERSONAL_PROJECT,
    delivery: "local-only",
    clones: { [host]: clone },
    yolo: false,
    repo: null,
  });
}
