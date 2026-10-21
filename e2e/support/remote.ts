import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    encoding: "utf8",
  }).trim();

export const tip = (repo: string, ref = "main"): string => git(repo, "rev-parse", ref);

export function addRemote(clone: string): string {
  const remote = `${clone}.git`;
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  git(clone, "remote", "add", "origin", remote);
  git(clone, "push", "-q", "-u", "origin", "main");
  return remote;
}

export function cloneWithRemote(dir: string, name: string): { clone: string; remote: string } {
  const clone = join(dir, name);
  execFileSync("git", ["init", "-q", "-b", "main", clone]);
  writeFileSync(join(clone, "README"), `${name}\n`);
  git(clone, "add", "README");
  git(clone, "commit", "-q", "-m", "readme");
  return { clone, remote: addRemote(clone) };
}

export function landOnRemote(remote: string, message: string): string {
  const other = join(mkdtempSync(join(dirname(remote), "other-")), "repo");
  execFileSync("git", ["clone", "-q", remote, other]);
  writeFileSync(join(other, `${message}.txt`), `${message}\n`);
  git(other, "add", "-A");
  git(other, "commit", "-q", "-m", message);
  git(other, "push", "-q", "origin", "main");
  return tip(other);
}
