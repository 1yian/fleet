import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { homedir, hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { callCardd } from "./cardd-call.ts";
import {
  NO_MISTAKES_REPO,
  noMistakesBuild,
  noMistakesRefusal,
  PI_TIERS_SOURCE,
} from "./dependencies.ts";
import { readLaneConfig } from "./lane-config.ts";
import { hostProblems } from "./prerequisites.ts";
import { NO_MISTAKES_TEMPLATE, TIERS_TEMPLATE, tiersConfigPath } from "./tiers-config.ts";

const PROBE_TIMEOUT_MS = 30_000;
const CLONE_TIMEOUT_MS = 300_000;
const BUILD_TIMEOUT_MS = 900_000;
const ERROR_LINES = 6;
const BUILDINFO = "github.com/kunchenguid/no-mistakes/internal/buildinfo";
const REMINDER_PREFIX = "Daily fleet update:";
const REMINDER_AT = "05:00";
const REMINDER_TEXT = `${REMINDER_PREFIX} run update_fleet, then on every host: pi update; pi install ${PI_TIERS_SOURCE} then pi update ${PI_TIERS_SOURCE} (moves a pinned ref); fleet install --latest for the no-mistakes fork (never no-mistakes update); and bump any other pinned tool. Restart a no-mistakes daemon only when no pipeline runs. Report changes. To stop this, set "updateReminder": false in config/lane.json and run fleet install.`;

export interface InstallLine {
  readonly text: string;
  readonly failed: boolean;
}

function run(
  file: string,
  args: readonly string[],
  options: { cwd?: string; timeout?: number; env?: NodeJS.ProcessEnv } = {},
): string {
  return execFileSync(file, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: options.timeout ?? PROBE_TIMEOUT_MS,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.env === undefined ? {} : { env: options.env }),
  }).trim();
}

function probe(file: string, args: readonly string[]): string | undefined {
  try {
    return run(file, args);
  } catch {
    return undefined;
  }
}

function reason(error: unknown): string {
  const stderr: unknown = Reflect.get(Object(error), "stderr");
  const cause: unknown = Reflect.get(Object(error), "cause");
  const said = error instanceof Error ? error.message : String(error);
  const own = typeof stderr === "string" && stderr.trim() !== "" ? stderr : said;
  const text =
    cause === undefined
      ? own
      : `${own}\n${cause instanceof Error ? cause.message : JSON.stringify(cause)}`;
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .slice(0, ERROR_LINES)
    .join(" | ");
}

function buildNoMistakes(): { commit: string; target: string } {
  const work = mkdtempSync(join(tmpdir(), "fleet-no-mistakes-"));
  try {
    const source = join(work, "source");
    run("git", ["clone", "--quiet", "--depth", "1", NO_MISTAKES_REPO, source], {
      timeout: CLONE_TIMEOUT_MS,
    });
    const commit = run("git", ["-C", source, "rev-parse", "--short=8", "HEAD"]);
    const committed = run("git", ["-C", source, "show", "-s", "--format=%cI", "HEAD"]);
    const date = new Date(committed).toISOString().replace(/\.\d{3}Z$/, "Z");
    const target = join(homedir(), ".local", "bin", "no-mistakes");
    mkdirSync(dirname(target), { recursive: true });
    const next = `${target}.new`;
    const flags = [`Version=fork-${commit}`, `Commit=${commit}`, `Date=${date}`]
      .map((each) => `-X ${BUILDINFO}.${each}`)
      .join(" ");
    run("go", ["build", "-trimpath", "-ldflags", flags, "-o", next, "./cmd/no-mistakes"], {
      cwd: source,
      env: { ...process.env, CGO_ENABLED: "0" },
      timeout: BUILD_TIMEOUT_MS,
    });
    renameSync(next, target);
    return { commit, target };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

const remoteHead = (): string =>
  run("git", ["ls-remote", NO_MISTAKES_REPO, "HEAD"], { timeout: CLONE_TIMEOUT_MS }).slice(0, 8);

function goMissing(current: string | undefined, installed: { commit: string } | undefined): Error {
  const state =
    current === undefined
      ? "missing"
      : (noMistakesRefusal(current) ?? `fork-${installed?.commit ?? ""} is not the latest`);
  return new Error(
    `${state} and cannot be built, because go is missing. Fix: install Go 1.25 or later (brew install go, or apt install golang-go), then run fleet install again`,
  );
}

function builtCommit(): { version: string | undefined; commit: string | undefined } {
  const version = probe("no-mistakes", ["--version"]);
  return { version, commit: version === undefined ? undefined : noMistakesBuild(version)?.commit };
}

function alreadyInstalled(
  latest: boolean,
  current: string | undefined,
  commit: string,
): string | undefined {
  if (current === undefined || noMistakesRefusal(current) !== undefined) return undefined;
  if (!latest) return `no-mistakes: fork-${commit} is installed`;
  return commit === remoteHead() ? `no-mistakes: fork-${commit} is the latest` : undefined;
}

function installNoMistakes(latest: boolean): string {
  const current = probe("no-mistakes", ["--version"]);
  const installed = current === undefined ? undefined : noMistakesBuild(current);
  const done = alreadyInstalled(latest, current, installed?.commit ?? "");
  if (done !== undefined) return done;
  if (probe("go", ["version"]) === undefined) throw goMissing(current, installed);
  const built = buildNoMistakes();
  const after = builtCommit();
  if (after.commit !== built.commit)
    throw new Error(
      `built fork-${built.commit} into ${built.target}, but the no-mistakes on the PATH is ${after.version === undefined ? "missing" : `"${after.version}"`}. Fix: put ${dirname(built.target)} first on the PATH`,
    );
  return `no-mistakes: built fork-${built.commit} into ${built.target}`;
}

function piTiersListed(listed: string): boolean {
  return listed.split("\n").some((line) => {
    if (!/^ {2}\S/.test(line)) return false;
    const source = line.slice(2).replace(/ \(filtered\)$/, "");
    return source === PI_TIERS_SOURCE || source.startsWith(`${PI_TIERS_SOURCE}@`);
  });
}

function installPiTiers(): string {
  const listed = probe("pi", ["list"]);
  if (listed === undefined)
    throw new Error(
      "pi is missing or does not run. Fix: npm install -g @earendil-works/pi-coding-agent",
    );
  if (piTiersListed(listed)) return "pi-tiers: installed in Pi";
  run("pi", ["install", PI_TIERS_SOURCE], { timeout: CLONE_TIMEOUT_MS });
  return `pi-tiers: installed in Pi from ${PI_TIERS_SOURCE}`;
}

function writeIfAbsent(name: string, target: string, template: string): string {
  if (existsSync(target)) return `${name}: ${target} exists and is kept`;
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  copyFileSync(template, target);
  return `${name}: wrote ${target} from ${template}`;
}

const noMistakesConfigPath = (): string =>
  join(process.env["NM_HOME"] ?? join(homedir(), ".no-mistakes"), "config.yaml");

async function reminder(root: string): Promise<string> {
  const main = readLaneConfig(root);
  if (main === undefined)
    return "update reminder: skipped, this host is not main's (no config/lane.json in the checkout)";
  const mine = (await callCardd(main, "schedule.list", {})).filter(
    ({ owner, to, text, on }) =>
      owner === main.lane && to === main.lane && on === null && text.startsWith(REMINDER_PREFIX),
  );
  if (main.updateReminder === false) {
    for (const { id } of mine) await callCardd(main, "schedule.remove", { id });
    const ids = mine.map(({ id }) => `#${String(id)}`).join(", ");
    return mine.length === 0
      ? "update reminder: off"
      : `update reminder: off, removed schedule ${ids}`;
  }
  const [existing] = mine;
  if (existing !== undefined)
    return `update reminder: already set (schedule #${String(existing.id)}, daily at ${existing.at} ${existing.timezone})`;
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const made = await callCardd(main, "schedule.set", {
    to: main.lane,
    at: REMINDER_AT,
    timezone,
    text: REMINDER_TEXT,
  });
  return `update reminder: created schedule #${String(made.id)}, daily at ${REMINDER_AT} ${timezone}, to ${main.lane}`;
}

export async function install(root: string, latest: boolean): Promise<InstallLine[]> {
  const lines: InstallLine[] = [];
  const attempt = async (name: string, step: () => string | Promise<string>): Promise<void> => {
    try {
      lines.push({ text: await step(), failed: false });
    } catch (error) {
      lines.push({ text: `${name}: ${reason(error)}`, failed: true });
    }
  };
  await attempt("no-mistakes", () => installNoMistakes(latest));
  await attempt("pi-tiers", installPiTiers);
  await attempt("tiers", () => writeIfAbsent("tiers", tiersConfigPath(), TIERS_TEMPLATE));
  await attempt("no-mistakes config", () =>
    writeIfAbsent("no-mistakes config", noMistakesConfigPath(), NO_MISTAKES_TEMPLATE),
  );
  for (const problem of hostProblems(root))
    if (!problem.startsWith("no-mistakes ")) lines.push({ text: problem, failed: true });
  await attempt("update reminder", () => reminder(root));
  if (!lines.some(({ failed }) => failed))
    lines.push({ text: `install: ${hostname()} is ready`, failed: false });
  return lines;
}
