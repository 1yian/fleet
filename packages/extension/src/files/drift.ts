import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "../lane-config.ts";
import type { World } from "./world.ts";

const LS_REMOTE_TIMEOUT_MS = 20_000;

function lockedRev(flakeLock: string): string | undefined {
  const lock: unknown = JSON.parse(readFileSync(flakeLock, "utf8"));
  const nodes = isRecord(lock) && isRecord(lock["nodes"]) ? lock["nodes"] : {};
  const ystack = isRecord(nodes["ystack"]) ? nodes["ystack"] : {};
  const locked = isRecord(ystack["locked"]) ? ystack["locked"] : {};
  return typeof locked["rev"] === "string" ? locked["rev"] : undefined;
}

function newestTag(clone: string): { tag: string; commit: string } | undefined {
  const listed = spawnSync("git", ["-C", clone, "ls-remote", "--tags", "origin"], {
    encoding: "utf8",
    timeout: LS_REMOTE_TIMEOUT_MS,
  });
  if (listed.status !== 0) return undefined;
  const commits = new Map<string, string>();
  for (const line of listed.stdout.split("\n")) {
    const [sha, ref] = line.split("\t");
    if (sha === undefined || ref === undefined) continue;
    const tag = ref.replace("refs/tags/", "").replace(/\^\{\}$/, "");
    if (ref.endsWith("^{}") || !commits.has(tag)) commits.set(tag, sha);
  }
  const tags = [...commits.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const tag = tags.at(-1);
  const commit = tag === undefined ? undefined : commits.get(tag);
  return tag === undefined || commit === undefined ? undefined : { tag, commit };
}

export function driftLine(world: World): string {
  const dotfiles = world.clones.find((clone) => clone.project === "dotfiles");
  const ystack = world.clones.find((clone) => clone.project === "ystack");
  if (dotfiles === undefined || ystack === undefined)
    return "release: unknown, this host has no clone of dotfiles or ystack";
  let rev: string | undefined;
  try {
    rev = lockedRev(join(dotfiles.path, "flake.lock"));
  } catch {
    rev = undefined;
  }
  if (rev === undefined) return "release: unknown, no ystack rev in the dotfiles flake.lock";
  const newest = newestTag(ystack.path);
  if (newest === undefined)
    return `release: ystack ${rev.slice(0, 12)}, origin's tags cannot be read`;
  const state = newest.commit === rev ? "current" : `behind ${newest.tag}`;
  return `release: ystack ${rev.slice(0, 12)} in the dotfiles flake.lock, newest tag ${newest.tag}: ${state}`;
}
