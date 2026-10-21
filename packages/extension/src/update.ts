import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { laneHomes } from "./homes.ts";

const BRANCH = "main";
const UPSTREAM = `origin/${BRANCH}`;
const INSTALL_TIMEOUT_MS = 540_000;

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

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

const attempt = (run: () => string): { ok: true; out: string } | { ok: false; error: string } => {
  try {
    return { ok: true, out: run() };
  } catch (error) {
    const stderr: unknown = Reflect.get(Object(error), "stderr");
    const text = typeof stderr === "string" && stderr.trim() !== "" ? stderr : String(error);
    return { ok: false, error: text.trim().split("\n").slice(-5).join(" | ") };
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

export function updateHost(root: string): HostUpdate {
  const refused = checkHost(root);
  if (refused !== undefined) return refused;
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
  const touches = (...prefixes: string[]): boolean =>
    changed.some((file) => prefixes.some((prefix) => file.startsWith(prefix)));
  const built = build(root, changed);
  if (!built.ok) return failed(built.step, built.error, to);
  const lanes: string[] = [];
  for (const { lane, home } of laneHomes(root)) {
    const moved = attempt(() => git(home, "checkout", "--quiet", "--detach", to));
    if (!moved.ok) return failed(`move lane ${lane}'s home`, moved.error, to);
    lanes.push(lane);
  }
  return {
    state: "updated",
    root,
    from,
    to,
    commits: from === to ? 0 : Number(git(root, "rev-list", "--count", `${from}..${to}`)),
    installed: built.installed,
    boardChanged: touches("packages/board/", "packages/protocol/", "package-lock.json"),
    carddChanged: touches("packages/cardd/", "packages/protocol/", "package-lock.json"),
    lanes,
  };
}
