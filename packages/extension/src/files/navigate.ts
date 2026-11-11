import { spawnSync } from "node:child_process";
import { rootsOf, type Root } from "./roots.ts";
import type { World } from "./world.ts";

function cdTo(path: string): number {
  const run = spawnSync("ya", ["emit", "cd", path], { stdio: "inherit" });
  if (run.error !== undefined) {
    console.error("fleet files: ya is not on the PATH, so yazi cannot be told to go there");
    return 1;
  }
  return run.status ?? 1;
}

export async function goto(world: World, name: string): Promise<number> {
  const found = (await rootsOf(world)).find(
    (root) => root.name === name || root.name.startsWith(`${name} `),
  );
  if (found === undefined) {
    console.error(`fleet files: there is no ${name} folder here yet`);
    return 1;
  }
  return cdTo(found.path);
}

const KINDS: Record<string, readonly string[]> = {
  clone: ["clone ", "scratch "],
  worktree: ["worker ", "scratch "],
};

function chosen(rows: readonly Root[], kind: string): string | undefined {
  const picked = spawnSync(
    "fzf",
    ["--delimiter", "\t", "--with-nth", "1", "--prompt", `${kind}> `],
    {
      input: rows.map((row) => `${row.name}\t${row.path}`).join("\n"),
      encoding: "utf8",
      stdio: ["pipe", "pipe", "inherit"],
    },
  );
  if (picked.error !== undefined)
    throw new Error("fleet files: fzf is not installed, so there is no picker. Install fzf");
  return picked.stdout.trim().split("\t")[1];
}

export async function pick(world: World, kind: string): Promise<number> {
  const prefixes = KINDS[kind];
  if (prefixes === undefined) throw new Error("fleet files pick clone|worktree");
  const rows = (await rootsOf(world)).filter((root) =>
    prefixes.some((prefix) => root.name.startsWith(prefix)),
  );
  if (rows.length === 0) {
    console.error(`fleet files: this lane has no ${kind} here`);
    return 1;
  }
  const path = chosen(rows, kind);
  return path === undefined || path === "" ? 0 : cdTo(path);
}
