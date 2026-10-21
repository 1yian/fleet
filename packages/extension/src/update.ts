import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { laneHomes } from "./homes.ts";

const BRANCH = "main";
const UPSTREAM = `origin/${BRANCH}`;
const INSTALL_TIMEOUT_MS = 540_000;
const ERROR_LINES = 6;
const RESTART_TIMEOUT_MS = 60_000;
const CARDD_CODE = ["packages/cardd/", "packages/protocol/", "package-lock.json"];
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

export type HostUpdate =
  | { readonly state: "refused"; readonly root: string; readonly problems: readonly string[] }
  | {
      readonly state: "failed";
      readonly root: string;
      readonly step: string;
      readonly error: string;
      readonly from: string;
      readonly to: string;
    }
  | {
      readonly state: "updated";
      readonly root: string;
      readonly from: string;
      readonly to: string;
      readonly commits: number;
      readonly installed: boolean;
      readonly boardChanged: boolean;
      readonly carddChanged: boolean;
      readonly lanes: readonly string[];
    };

interface Pulled {
  readonly from: string;
  readonly to: string;
  readonly commits: number;
}

interface CarddRestart {
  readonly backup: string;
  readonly schema: number;
  readonly migrations: number;
}

export type CarddUpdate =
  | Exclude<HostUpdate, { state: "updated" }>
  | (Pulled & {
      readonly state: "updated";
      readonly root: string;
      readonly installed: boolean;
      readonly restart?: CarddRestart;
    });

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

const attempt = <T>(run: () => T): { ok: true; out: T } | { ok: false; error: string } => {
  try {
    return { ok: true, out: run() };
  } catch (error) {
    const stderr: unknown = Reflect.get(Object(error), "stderr");
    const text = typeof stderr === "string" && stderr.trim() !== "" ? stderr : String(error);
    const lines = text.replaceAll(ANSI, "").split("\n");
    const shown = lines.map((line) => line.trim()).filter((line) => line !== "");
    return { ok: false, error: shown.slice(0, ERROR_LINES).join(" | ") };
  }
};

const onUpstream = (dir: string): boolean =>
  attempt(() => git(dir, "merge-base", "--is-ancestor", "HEAD", UPSTREAM)).ok;

function uncommitted(dir: string): string | undefined {
  const changes = git(dir, "status", "--porcelain").split("\n").filter(Boolean);
  if (changes.length === 0) return undefined;
  const shown = changes.slice(0, 3).map((line) => line.trim());
  return changes.length > 3
    ? `${shown.join(", ")}, and ${String(changes.length - 3)} more`
    : shown.join(", ");
}

function checkoutProblems(root: string): string[] {
  const branch = attempt(() => git(root, "symbolic-ref", "--quiet", "--short", "HEAD"));
  const onBranch = branch.ok && branch.out === BRANCH;
  const dirty = uncommitted(root);
  const fetched = attempt(() => git(root, "fetch", "--quiet", "origin"));
  return [
    ...(onBranch
      ? []
      : [
          `the checkout ${root} is on ${branch.ok ? branch.out : "a detached HEAD"}, not ${BRANCH}`,
        ]),
    ...(dirty === undefined ? [] : [`the checkout ${root} has uncommitted changes: ${dirty}`]),
    ...(fetched.ok ? [] : [`cannot fetch origin in ${root}: ${fetched.error}`]),
    ...(fetched.ok && onBranch && !onUpstream(root)
      ? [`the checkout ${root} has commits that are not on ${UPSTREAM}`]
      : []),
  ];
}

const homeProblems = (root: string): string[] =>
  laneHomes(root).flatMap(({ lane, home }) => {
    const changes = uncommitted(home);
    if (changes !== undefined)
      return [`lane ${lane}'s home ${home} has uncommitted changes: ${changes}`];
    return onUpstream(home)
      ? []
      : [`lane ${lane}'s home ${home} has commits that are not on ${UPSTREAM}`];
  });

const problemsOf = (root: string): string[] => [...checkoutProblems(root), ...homeProblems(root)];

export function checkHost(root: string): HostUpdate | undefined {
  const problems = problemsOf(root);
  return problems.length === 0 ? undefined : { state: "refused", root, problems };
}

const npm = (root: string, ...args: string[]): string =>
  execFileSync("npm", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: INSTALL_TIMEOUT_MS,
    env: { ...process.env, NO_COLOR: "1" },
  });

function build(
  root: string,
  changed: readonly string[],
): { ok: true; installed: boolean } | { ok: false; step: string; error: string } {
  const installed =
    changed.includes("package-lock.json") || !existsSync(join(root, "node_modules"));
  const install = installed ? attempt(() => npm(root, "ci", "--no-audit", "--no-fund")) : undefined;
  if (install?.ok === false) return { ok: false, step: "npm ci", error: install.error };
  const built = attempt(() => npm(root, "run", "build"));
  return built.ok
    ? { ok: true, installed }
    : { ok: false, step: "build the board", error: built.error };
}

type Step = { ok: true; pulled: Pulled; changed: string[]; installed: boolean } | HostUpdate;

function pullAndBuild(root: string): Step {
  const from = git(root, "rev-parse", "HEAD");
  const failed = (step: string, error: string, to = from): HostUpdate => ({
    state: "failed",
    root,
    step,
    error,
    from,
    to,
  });
  const pulled = attempt(() => git(root, "merge", "--quiet", "--ff-only", UPSTREAM));
  if (!pulled.ok) return failed(`pull ${UPSTREAM}`, pulled.error);
  const to = git(root, "rev-parse", "HEAD");
  const changed = from === to ? [] : git(root, "diff", "--name-only", from, to).split("\n");
  const built = build(root, changed);
  if (!built.ok) return failed(built.step, built.error, to);
  const commits = from === to ? 0 : Number(git(root, "rev-list", "--count", `${from}..${to}`));
  return { ok: true, pulled: { from, to, commits }, changed, installed: built.installed };
}

const touches = (changed: readonly string[], prefixes: readonly string[]): boolean =>
  changed.some((file) => prefixes.some((prefix) => file.startsWith(prefix)));

export function updateHost(root: string): HostUpdate {
  const refused = checkHost(root);
  if (refused !== undefined) return refused;
  const step = pullAndBuild(root);
  if (!("ok" in step)) return step;
  const { pulled, changed } = step;
  const lanes: string[] = [];
  for (const { lane, home } of laneHomes(root)) {
    const moved = attempt(() => git(home, "checkout", "--quiet", "--detach", pulled.to));
    if (!moved.ok)
      return {
        state: "failed",
        root,
        step: `move lane ${lane}'s home`,
        error: moved.error,
        ...pulled,
      };
    lanes.push(lane);
  }
  return {
    state: "updated",
    root,
    ...pulled,
    installed: step.installed,
    boardChanged: touches(changed, ["packages/board/", "packages/protocol/", "package-lock.json"]),
    carddChanged: touches(changed, CARDD_CODE),
    lanes,
  };
}

const expand = (path: string): string => path.replace(/^~(?=\/|$)/, homedir());

export function checkCardd(rootPath: string, dbPath: string): HostUpdate | undefined {
  const root = expand(rootPath);
  const db = expand(dbPath);
  const problems = [
    ...checkoutProblems(root),
    ...(existsSync(db) ? [] : [`cardd's database ${db} does not exist`]),
  ];
  return problems.length === 0 ? undefined : { state: "refused", root, problems };
}

function runsOldCode(root: string, running: string | undefined, to: string): boolean {
  if (running === undefined) return true;
  const changed = attempt(() => git(root, "diff", "--name-only", running, to));
  return !changed.ok || touches(changed.out.split("\n"), CARDD_CODE);
}

const migrationsIn = (root: string): number =>
  readdirSync(join(root, "packages", "cardd", "migrations")).filter((name) => name.endsWith(".sql"))
    .length;

function backUp(root: string, db: string): CarddRestart {
  const stamp = new Date()
    .toISOString()
    .replace(/\.\d+Z$/, "Z")
    .replaceAll(":", "-");
  const backup = join(dirname(db), `${basename(db, extname(db))}-backup-${stamp}${extname(db)}`);
  const open = new DatabaseSync(db);
  try {
    open.exec("PRAGMA busy_timeout = 5000");
    open.prepare("VACUUM INTO ?").run(backup);
    const schema = Number(open.prepare("PRAGMA user_version").get()?.["user_version"]);
    return { backup, schema, migrations: migrationsIn(root) };
  } finally {
    open.close();
  }
}

export function updateCardd(
  rootPath: string,
  dbPath: string,
  running: string | undefined,
  restart: readonly string[],
): CarddUpdate {
  const refused = checkCardd(rootPath, dbPath);
  if (refused !== undefined) return refused;
  const root = expand(rootPath);
  const step = pullAndBuild(root);
  if (!("ok" in step)) return step;
  const { pulled } = step;
  const updated = { state: "updated" as const, root, ...pulled, installed: step.installed };
  if (!runsOldCode(root, running, pulled.to)) return updated;
  const failed = (name: string, error: string): CarddUpdate => ({
    state: "failed",
    root,
    step: name,
    error,
    ...pulled,
  });
  const backedUp = attempt(() => backUp(root, expand(dbPath)));
  if (!backedUp.ok) return failed("back up cardd's database", backedUp.error);
  const [command = "", ...args] = restart;
  const restarted = attempt(() =>
    execFileSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: RESTART_TIMEOUT_MS,
    }),
  );
  if (!restarted.ok) return failed("restart cardd", restarted.error);
  return { ...updated, restart: backedUp.out };
}
