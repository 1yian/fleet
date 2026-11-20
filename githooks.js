import { spawnSync } from "node:child_process";
import console from "node:console";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import process from "node:process";

const hooksPath = ".githooks";
const maxScopedFiles = 400;
const pushLine = /^(\S+) ([0-9a-f]{40,64}) (\S+) ([0-9a-f]{40,64})$/;
const emptyObject = /^0+$/;

function git(args) {
  const result = spawnSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.error || result.status !== 0) return undefined;
  return result.stdout;
}

function install() {
  const top = git(["rev-parse", "--show-toplevel"])?.trim();
  if (!top || realpathSync(top) !== realpathSync(process.cwd())) return;
  const current = git(["config", "--get", "core.hooksPath"])?.trim();
  if (current === hooksPath) return;
  if (current) {
    console.warn(
      `core.hooksPath is already ${current}, so the pre-push checks in ${hooksPath} are not installed.`,
    );
    return;
  }
  if (git(["config", "--local", "core.hooksPath", hooksPath]) === undefined)
    console.warn(`Could not set core.hooksPath to ${hooksPath}.`);
}

function pushedCommits(input) {
  return input
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const fields = pushLine.exec(line);
      if (!fields) throw new Error(`Unexpected pre-push input: ${line}`);
      return { ref: fields[1], sha: fields[2] };
    })
    .filter(({ ref, sha }) => ref.startsWith("refs/heads/") && !emptyObject.test(sha));
}

function baseOf(remote, sha) {
  const candidates = [
    `refs/remotes/${remote}/HEAD`,
    "refs/remotes/origin/HEAD",
    "refs/remotes/origin/main",
    "refs/remotes/origin/master",
  ];
  for (const candidate of candidates) {
    const base = git(["merge-base", sha, candidate])?.trim();
    if (base) return base;
  }
  return undefined;
}

function changedSince(base, sha) {
  const output = git(["diff", "--name-only", "-z", "--diff-filter=d", base, sha]);
  return output === undefined ? undefined : output.split("\0").filter(Boolean);
}

function changedFiles(remote, commits) {
  const files = new Set();
  for (const { sha } of commits) {
    const base = baseOf(remote, sha);
    const changed = base === undefined ? undefined : changedSince(base, sha);
    if (changed === undefined) return undefined;
    for (const file of changed) files.add(file);
  }
  return [...files];
}

function steps(files) {
  const scope = files ? ["--", ...files] : [];
  return [
    { name: "format", script: files ? "format:files" : "format:check", args: scope },
    { name: "lint", script: "lint", args: scope },
    { name: "typecheck", script: "typecheck", args: [] },
  ];
}

function run({ script, args }) {
  const result = spawnSync("npm", ["run", "--silent", script, ...args], { stdio: "inherit" });
  if (result.error) throw result.error;
  return result.status === 0;
}

function prePush() {
  const top = git(["rev-parse", "--show-toplevel"])?.trim();
  if (!top) return 0;
  process.chdir(top);
  if (!existsSync("node_modules")) {
    console.warn(
      "pre-push: dependencies are not installed, so the checks were skipped. Run npm ci.",
    );
    return 0;
  }
  const head = git(["rev-parse", "HEAD"])?.trim();
  const pushed = pushedCommits(readFileSync(0, "utf8"));
  const commits = pushed.filter(({ sha }) => sha === head);
  for (const { ref } of pushed.filter(({ sha }) => sha !== head))
    console.warn(`pre-push: ${ref} is not checked out, so its checks were skipped.`);
  if (!commits.length) return 0;
  const found = changedFiles(process.argv[3] ?? "origin", commits);
  if (found && !found.length) return 0;
  const files = found && found.length <= maxScopedFiles ? found : undefined;
  console.error(
    files
      ? `pre-push: checking ${String(files.length)} changed files`
      : "pre-push: checking the whole project",
  );
  const started = Date.now();
  const failed = steps(files).filter((step) => !run(step));
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (!failed.length) {
    console.error(`pre-push: passed in ${seconds}s`);
    return 0;
  }
  console.error(
    `pre-push: ${failed.map(({ name }) => name).join(", ")} failed after ${seconds}s. Fix it and push again, or push with --no-verify to leave it to CI.`,
  );
  return 1;
}

const command = process.argv[2];
try {
  if (command === "install") install();
  else if (command === "pre-push") process.exitCode = prePush();
  else {
    console.error("Usage: node githooks.js install | pre-push");
    process.exitCode = 2;
  }
} catch (error) {
  console.error(error);
  process.exitCode = command === "install" ? 0 : 1;
}
