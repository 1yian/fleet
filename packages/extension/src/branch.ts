import { execFile } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { branchNameProblem, check, OPS } from "@fleet/protocol";
import Type from "typebox";
import type { Link } from "./link.ts";

const BranchParams = Type.Object({
  name: Type.String({
    minLength: 1,
    description:
      "The branch name, <type>/<slug>: type is feat, fix, refactor, perf, docs, test, chore, ci, or build, and slug is a short lowercase kebab-case summary of the change, at most 48 characters, such as fix/mileage-readback",
  }),
});

const REMOTE_WAIT_MS = 30_000;

interface Ran {
  readonly ok: boolean;
  readonly out: string;
  readonly err: string;
}

function git(cwd: string, args: readonly string[], timeout = 60_000): Promise<Ran> {
  return new Promise((done) => {
    execFile("git", ["-C", cwd, ...args], { encoding: "utf8", timeout }, (error, out, err) => {
      done({ ok: error === null, out: out.trim(), err: err.trim() });
    });
  });
}

async function takenAt(cwd: string, name: string): Promise<string | undefined> {
  if ((await git(cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`])).ok)
    return "in this clone";
  const tracked = await git(cwd, ["for-each-ref", "--format=%(refname)", `refs/remotes/*/${name}`]);
  if (tracked.out !== "") return "on origin";
  const origin = await git(cwd, ["remote", "get-url", "origin"]);
  if (!origin.ok) return undefined;
  const listed = await git(cwd, ["ls-remote", "--heads", "origin", name], REMOTE_WAIT_MS);
  return listed.ok && listed.out !== "" ? "on origin" : undefined;
}

async function nameBranch(link: Link, cwd: string, name: string): Promise<string> {
  const problem = branchNameProblem(name);
  if (problem !== undefined) throw new Error(problem);
  if (!(await git(cwd, ["check-ref-format", "--branch", name])).ok)
    throw new Error(`"${name}" is not a valid git branch name`);
  const current = await git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (!current.ok) throw new Error("You are on a detached HEAD: check out your task branch first");
  const from = current.out;
  if (from !== name) {
    const taken = await takenAt(cwd, name);
    if (taken !== undefined)
      throw new Error(`branch ${name} already exists ${taken}: choose a different slug`);
    const renamed = await git(cwd, ["branch", "-m", from, name]);
    if (!renamed.ok) throw new Error(`could not rename ${from} to ${name}: ${renamed.err}`);
  }
  try {
    check(OPS["branch.name"].result, await link.call("branch.name", { name }));
  } catch (error) {
    if (from !== name) await git(cwd, ["branch", "-m", name, from]);
    throw error;
  }
  return from === name
    ? `Branch ${name} is recorded as your task branch.`
    : `Renamed ${from} to ${name} and recorded it as your task branch. Open your PR from it.`;
}

export function registerBranch(pi: ExtensionAPI, link: Link): void {
  pi.registerTool({
    name: "branch",
    label: "Name branch",
    description:
      "Names your task branch, once, as your first action: <type>/<slug>, such as fix/mileage-readback. It renames the branch you are on and records the name with the fleet, which finds your PR, lands, and closes your card by it. It refuses a name that is malformed or already taken in this clone, on origin, or by another card. Never rename or create your task branch with git.",
    parameters: BranchParams,
    execute: async (_id, { name }) => {
      const text = await nameBranch(link, process.cwd(), name);
      return { content: [{ type: "text", text }], details: {} };
    },
  });
}
