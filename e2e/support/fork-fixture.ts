import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const FORK_MODULE = "github.com/kunchenguid/no-mistakes";
const FORK_URL = "https://github.com/1yian/no-mistakes";

const MAIN_GO = `package main

import "${FORK_MODULE}/internal/buildinfo"

func main() {
\tprintln("no-mistakes version", buildinfo.Version, buildinfo.Commit, buildinfo.Date)
}
`;

const BUILDINFO_GO = `package buildinfo

var (
\tVersion = "dev"
\tCommit  = "none"
\tDate    = "unknown"
)
`;

const git = (dir: string, when: string, ...args: string[]): string =>
  execFileSync(
    "git",
    [
      "-C",
      dir,
      "-c",
      "user.name=fork",
      "-c",
      "user.email=fork@example.com",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    {
      encoding: "utf8",
      env: { ...process.env, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when },
    },
  ).trim();

export function initFork(dir: string): void {
  mkdirSync(join(dir, "cmd", "no-mistakes"), { recursive: true });
  mkdirSync(join(dir, "internal", "buildinfo"), { recursive: true });
  writeFileSync(join(dir, "go.mod"), `module ${FORK_MODULE}\n\ngo 1.25\n`);
  writeFileSync(join(dir, "cmd", "no-mistakes", "main.go"), MAIN_GO);
  writeFileSync(join(dir, "internal", "buildinfo", "buildinfo.go"), BUILDINFO_GO);
  execFileSync("git", ["-C", dir, "init", "-q", "-b", "main"]);
}

export function commitFork(dir: string, when: string): string {
  writeFileSync(join(dir, "CHANGELOG"), `${when}\n`);
  git(dir, when, "add", "-A");
  git(dir, when, "commit", "-q", "-m", when);
  return git(dir, when, "rev-parse", "--short=8", "HEAD");
}

export function routeFork(dir: string): Record<string, string> {
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `url.${dir}.insteadOf`,
    GIT_CONFIG_VALUE_0: FORK_URL,
  };
}

export const currentDependencies = (): string =>
  `dependencies: Pi: pi is up to date, pi-tiers: Updated git:github.com/1yian/pi-tiers, no-mistakes: fork-${process.env["FAKE_NO_MISTAKES_COMMIT"] ?? ""} is the latest, fleet-browser: CLI and skill linked`;
