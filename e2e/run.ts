import { spawn, type ChildProcess } from "node:child_process";
import {
  closeSync,
  globSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { envMarker, killGroup, sweepMarked } from "./support/marked.ts";
import { diskBase, staleFolders } from "./support/run-folders.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SUITE_PREFIX = "fe-";
const SUITE_MINUTES = 120;
const FILE_MINUTES = 20;
const TEST_TIMEOUT_MS = 300_000;
const LEFTOVER_GRACE_MS = 5_000;
const TERM_GRACE_MS = 5_000;
const CORES_PER_FILE = 16;
const MAX_DEFAULT_FILES = 8;

interface Outcome {
  readonly file: string;
  readonly ms: number;
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly swept: readonly string[];
  readonly stuck: number;
  readonly counts: Readonly<Record<string, number>>;
  readonly log: string;
}

const failed = (outcome: Outcome): boolean =>
  outcome.code !== 0 || outcome.timedOut || outcome.stuck > 0;

const markerOf = (token: string, indexed = false): RegExp =>
  envMarker("FLEET_E2E_RUN", token, indexed);

function concurrency(): number {
  const named = Number(process.env["FLEET_E2E_CONCURRENCY"]);
  if (Number.isInteger(named) && named > 0) return named;
  return Math.min(
    MAX_DEFAULT_FILES,
    Math.max(1, Math.floor(availableParallelism() / CORES_PER_FILE)),
  );
}

function countsIn(log: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const found of log.matchAll(/^ℹ (tests|pass|fail|cancelled|skipped) (\d+)$/gm)) {
    counts[found[1] ?? ""] = Number(found[2]);
  }
  return counts;
}

async function exitOf(
  child: ChildProcess,
): Promise<{ code: number | null; signal: NodeJS.Signals | null; timedOut: boolean }> {
  const pid = child.pid ?? 0;
  const late = { timedOut: false };
  const deadline = setTimeout(() => {
    late.timedOut = true;
    killGroup(pid, "SIGKILL");
  }, FILE_MINUTES * 60_000);
  const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) => {
    child.once("error", () => {
      resolve([1, null]);
    });
    child.once("exit", (exitCode, exitSignal) => {
      resolve([exitCode, exitSignal]);
    });
  });
  clearTimeout(deadline);
  killGroup(pid, "SIGKILL");
  return { code, signal, timedOut: late.timedOut };
}

function report(outcome: Outcome): void {
  const seconds = (outcome.ms / 1000).toFixed(1).padStart(6);
  console.log(`${failed(outcome) ? "FAIL" : "ok  "} ${seconds}s ${outcome.file}`);
  for (const line of outcome.swept) console.log(`swept after ${outcome.file}: ${line}`);
  if (!failed(outcome)) return;
  const why = outcome.timedOut
    ? `timed out after ${String(FILE_MINUTES)} minutes`
    : `exit ${String(outcome.code)}${outcome.signal === null ? "" : ` (${outcome.signal})`}`;
  console.log(`----- ${outcome.file}: ${why}\n${outcome.log}\n----- end of ${outcome.file}`);
}

class Suite {
  readonly dir: string;
  readonly id: string;
  readonly base: string;
  private readonly running = new Set<ChildProcess>();
  private stopping = false;
  private started = 0;

  constructor(base: string) {
    this.base = base;
    this.id = `${SUITE_PREFIX}${String(process.pid)}`;
    this.dir = join(base, this.id);
    rmSync(this.dir, { recursive: true, force: true });
    mkdirSync(this.dir);
  }

  get interrupted(): boolean {
    return this.stopping;
  }

  async run(files: readonly string[], width: number): Promise<Outcome[]> {
    const queue = [...files];
    const outcomes: Outcome[] = [];
    const lane = async (): Promise<void> => {
      for (let file = queue.shift(); file !== undefined && !this.stopping; file = queue.shift()) {
        const outcome = await this.runFile(file);
        outcomes.push(outcome);
        report(outcome);
      }
    };
    await Promise.all(Array.from({ length: Math.min(width, files.length) }, lane));
    return outcomes;
  }

  stop(signal: NodeJS.Signals): void {
    this.stopping = true;
    this.signalAll(signal);
  }

  signalAll(signal: NodeJS.Signals): void {
    for (const child of this.running) {
      if (child.pid !== undefined) killGroup(child.pid, signal);
    }
  }

  async finish(): Promise<{ swept: readonly string[]; stuck: number }> {
    const { named, survivors } = await sweepMarked(markerOf(this.id, true), LEFTOVER_GRACE_MS);
    rmSync(this.dir, { recursive: true, force: true });
    return { swept: named, stuck: survivors };
  }

  private async runFile(file: string): Promise<Outcome> {
    const index = this.started++;
    const root = join(this.dir, String(index));
    mkdirSync(root);
    const logPath = `${root}.log`;
    const fd = openSync(logPath, "w");
    const began = Date.now();
    const child = spawn(
      process.execPath,
      ["--test", `--test-timeout=${String(TEST_TIMEOUT_MS)}`, "--test-reporter=spec", file],
      { cwd: ROOT, env: this.env(index, root), detached: true, stdio: ["ignore", fd, fd] },
    );
    closeSync(fd);
    this.running.add(child);
    const { code, signal, timedOut } = await exitOf(child);
    this.running.delete(child);
    const { named, survivors } = await sweepMarked(
      markerOf(`${this.id}.${String(index)}`),
      LEFTOVER_GRACE_MS,
    );
    const log = readFileSync(logPath, "utf8");
    rmSync(logPath, { force: true });
    rmSync(root, { recursive: true, force: true });
    const clean = code === 0 && !timedOut && survivors === 0;
    return {
      file,
      ms: Date.now() - began,
      code,
      signal,
      timedOut,
      swept: named,
      stuck: survivors,
      counts: countsIn(log),
      log: clean ? "" : log,
    };
  }

  private env(index: number, root: string): NodeJS.ProcessEnv {
    return {
      ...process.env,
      FLEET_E2E_ROOT: root,
      FLEET_E2E_TMPDIR: this.dir,
      FLEET_E2E_RUN: `${this.id}.${String(index)}`,
      FLEET_E2E_CACHE: join(this.base, "fleet-e2e-cache"),
    };
  }
}

function summarize(outcomes: readonly Outcome[], wallMs: number, width: number): void {
  const total = (name: string): number =>
    outcomes.reduce((sum, outcome) => sum + (outcome.counts[name] ?? 0), 0);
  console.log("\nslowest files:");
  for (const outcome of [...outcomes].sort((a, b) => b.ms - a.ms).slice(0, 10)) {
    console.log(`  ${(outcome.ms / 1000).toFixed(1).padStart(7)}s ${outcome.file}`);
  }
  const fileMs = outcomes.reduce((all, outcome) => all + outcome.ms, 0);
  console.log(
    `\n${String(outcomes.length)} files, ${String(total("tests"))} tests, ${String(total("pass"))} passed, ${String(total("fail"))} failed, ${String(total("skipped"))} skipped`,
  );
  console.log(
    `wall ${(wallMs / 60_000).toFixed(1)} min with ${String(width)} files at a time, ${(fileMs / 60_000).toFixed(1)} min of file time in all`,
  );
}

function writeReport(
  path: string,
  outcomes: readonly Outcome[],
  wallMs: number,
  width: number,
): void {
  const files = outcomes.map(({ file, ms, code, signal, timedOut, swept, stuck, counts }) => ({
    file,
    ms,
    code,
    signal,
    timedOut,
    swept,
    stuck,
    counts,
  }));
  writeFileSync(path, `${JSON.stringify({ wallMs, concurrency: width, files }, null, 2)}\n`);
}

function filesToRun(): string[] {
  const named = process.argv.slice(2);
  return named.length > 0 ? named : globSync("e2e/**/*.test.ts", { cwd: ROOT }).sort();
}

function watchSignals(suite: Suite): void {
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => {
      suite.stop(signal);
      setTimeout(() => {
        suite.signalAll("SIGKILL");
      }, TERM_GRACE_MS).unref();
    });
  }
}

function sweepStaleSuites(base: string): void {
  for (const name of staleFolders(base, SUITE_PREFIX)) {
    rmSync(join(base, name), { recursive: true, force: true });
  }
}

function conclude(
  suite: Suite,
  outcomes: readonly Outcome[],
  after: { swept: readonly string[]; stuck: number },
): number {
  for (const line of after.swept) console.log(`swept after the suite: ${line}`);
  const bad = outcomes.filter(failed).length;
  const swept = outcomes.reduce((sum, outcome) => sum + outcome.swept.length, after.swept.length);
  const stuck = outcomes.reduce((sum, outcome) => sum + outcome.stuck, after.stuck);
  console.log(
    suite.interrupted
      ? "interrupted"
      : `${String(bad)} files failed, ${String(swept)} leftover processes swept, ${String(stuck)} could not be killed`,
  );
  return suite.interrupted || bad > 0 || stuck > 0 ? 1 : 0;
}

async function main(): Promise<number> {
  const base = process.env["FLEET_E2E_TMPDIR"] ?? diskBase();
  mkdirSync(base, { recursive: true });
  sweepStaleSuites(base);
  const files = filesToRun();
  if (files.length === 0) {
    console.error("no end-to-end test files");
    return 1;
  }
  const suite = new Suite(base);
  const width = concurrency();
  const began = Date.now();
  const deadline = setTimeout(() => {
    console.error(`End-to-end suite exceeded ${String(SUITE_MINUTES)} minutes`);
    suite.stop("SIGKILL");
  }, SUITE_MINUTES * 60_000);
  watchSignals(suite);
  console.log(`${String(files.length)} files, ${String(width)} at a time, in ${suite.dir}`);
  const outcomes = await suite.run(files, width);
  clearTimeout(deadline);
  const after = await suite.finish();
  const wallMs = Date.now() - began;
  summarize(outcomes, wallMs, width);
  const reportPath = process.env["FLEET_E2E_REPORT"];
  if (reportPath !== undefined && reportPath !== "")
    writeReport(reportPath, outcomes, wallMs, width);
  return conclude(suite, outcomes, after);
}

process.exitCode = await main();
