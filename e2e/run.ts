import { spawn, type ChildProcess } from "node:child_process";
import {
  closeSync,
  existsSync,
  globSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  GROUPS_ENV,
  groupIdentity,
  groupScopes,
  registerGroup,
  signalOwnedGroup,
  sweepGroups,
  type Swept,
} from "./support/marked.ts";
import { runBase } from "./support/run-folders.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SUITE_MINUTES = 120;
const FILE_MINUTES = 20;
const TEST_TIMEOUT_MS = 300_000;
const LEFTOVER_GRACE_MS = 5_000;
const TERM_GRACE_MS = 5_000;
const CORES_PER_FILE = 16;
const MAX_DEFAULT_FILES = 8;
const COUNT_FIELDS = ["tests", "pass", "fail", "cancelled", "skipped"];

interface Outcome {
  readonly file: string;
  readonly ms: number;
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly swept: readonly string[];
  readonly stuck: number;
  readonly counts: Readonly<Record<string, number>> | undefined;
  readonly log: string;
}

const failed = (outcome: Outcome): boolean =>
  outcome.code !== 0 || outcome.timedOut || outcome.stuck > 0;

function concurrency(): number {
  const cap = Math.min(
    MAX_DEFAULT_FILES,
    Math.max(1, Math.floor(availableParallelism() / CORES_PER_FILE)),
  );
  const override = process.env["FLEET_E2E_CONCURRENCY"];
  if (override === undefined) return cap;
  const width = Number(override);
  if (!/^\d+$/.test(override) || width < 1 || width > cap) {
    throw new Error(`FLEET_E2E_CONCURRENCY must be an integer from 1 to ${String(cap)}`);
  }
  return width;
}

function countsIn(log: string): Record<string, number> | undefined {
  const counts: Record<string, number> = {};
  for (const found of log.matchAll(/^ℹ (tests|pass|fail|cancelled|skipped) (\d+)$/gm)) {
    counts[found[1] ?? ""] = Number(found[2]);
  }
  return COUNT_FIELDS.every((name) => counts[name] !== undefined) ? counts : undefined;
}

async function exitOf(
  child: ChildProcess,
  identity: string | undefined,
): Promise<{ code: number | null; signal: NodeJS.Signals | null; timedOut: boolean }> {
  const late = { timedOut: false };
  const deadline = setTimeout(() => {
    late.timedOut = true;
    signalOwnedGroup(child.pid, identity, "SIGKILL");
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
  private readonly scopes = new Set<string>();
  private readonly running = new Map<ChildProcess, string | undefined>();
  private stopping = false;
  private started = 0;
  private launched = 0;
  readonly outcomes: Outcome[] = [];

  get missingFooters(): number {
    return this.launched - this.outcomes.filter((outcome) => outcome.counts !== undefined).length;
  }

  constructor(base: string) {
    this.dir = mkdtempSync(join(base, "fe-"));
  }

  get interrupted(): boolean {
    return this.stopping;
  }

  async run(files: readonly string[], width: number): Promise<void> {
    const queue = [...files];
    const lane = async (): Promise<void> => {
      try {
        while (!this.stopping) {
          const file = queue.shift();
          if (file === undefined) return;
          const outcome = await this.runFile(file);
          this.outcomes.push(outcome);
          report(outcome);
        }
      } catch (error) {
        this.stop("SIGKILL");
        throw error;
      }
    };
    const drained = await Promise.allSettled(
      Array.from({ length: Math.min(width, files.length) }, lane),
    );
    const fault = drained.find((result) => result.status === "rejected");
    if (fault !== undefined) throw fault.reason;
  }

  stop(signal: NodeJS.Signals): void {
    this.stopping = true;
    this.signalAll(signal);
    if (signal !== "SIGKILL") {
      setTimeout(() => {
        this.signalAll("SIGKILL");
      }, TERM_GRACE_MS).unref();
    }
  }

  private signalAll(signal: NodeJS.Signals): void {
    for (const [child, identity] of this.running) signalOwnedGroup(child.pid, identity, signal);
  }

  async finish(): Promise<Swept> {
    const remaining = await Promise.all([...this.scopes].map((scope) => sweepGroups(scope, 0)));
    const retained = [...this.scopes].some((scope) => existsSync(join(dirname(scope), "unresolved-groups")));
    const survivors = remaining.reduce((sum, result) => sum + result.survivors, 0);
    if (retained && survivors === 0) {
      console.error(`unresolved process ownership; kept ${this.dir}`);
      return { named: [], survivors: 1 };
    }
    if (survivors === 0) rmSync(this.dir, { recursive: true, force: true });
    else console.error(`unresolved process ownership; kept ${this.dir}`);
    return { named: remaining.flatMap((result) => result.named), survivors };
  }

  private async runFile(file: string): Promise<Outcome> {
    const index = this.started++;
    const root = join(this.dir, String(index));
    mkdirSync(root, { mode: 0o700 });
    const scope = join(root, "groups");
    mkdirSync(scope, { mode: 0o700 });
    this.scopes.add(scope);
    const env = {
      ...process.env,
      FLEET_E2E_ROOT: root,
      FLEET_E2E_TMPDIR: this.dir,
      [GROUPS_ENV]: [...groupScopes(), scope].join("\n"),
      FORCE_COLOR: "0",
    };
    const logPath = `${root}.log`;
    const fd = openSync(logPath, "wx", 0o600);
    const began = Date.now();
    const { code, signal, timedOut } = await (async () => {
      try {
        const child = spawn(
          process.execPath,
          ["--test", `--test-timeout=${String(TEST_TIMEOUT_MS)}`, "--test-reporter=spec", file],
          { cwd: ROOT, env, detached: true, stdio: ["ignore", fd, fd] },
        );
        if (child.pid !== undefined) this.launched++;
        const identity = child.pid === undefined ? undefined : groupIdentity(child.pid);
        const exited = exitOf(child, identity);
        this.running.set(child, identity);
        try {
          try {
            registerGroup(child.pid, env, identity);
          } catch (error) {
            this.stop("SIGKILL");
            await exited;
            throw error;
          }
          return await exited;
        } finally {
          this.running.delete(child);
        }
      } finally {
        closeSync(fd);
      }
    })();
    const { named, survivors } = await sweepGroups(scope, LEFTOVER_GRACE_MS);
    const log = readFileSync(logPath, "utf8");
    if (survivors === 0 && !existsSync(join(root, "unresolved-groups"))) {
      rmSync(logPath, { force: true });
      rmSync(root, { recursive: true, force: true });
      this.scopes.delete(scope);
    }
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
}

function summarize(suite: Suite, wallMs: number, width: number): void {
  const { outcomes, missingFooters } = suite;
  const total = (name: string): number =>
    outcomes.reduce((sum, outcome) => sum + (outcome.counts?.[name] ?? 0), 0);
  const partial = missingFooters === 0 ? "" : ` (partial counts: ${String(missingFooters)} missing footers)`;
  console.log(
    `\n${String(outcomes.length)} files, ${String(total("tests"))} tests, ${String(total("pass"))} passed, ${String(total("fail"))} failed, ${String(total("cancelled"))} cancelled, ${String(total("skipped"))} skipped${partial}`,
  );
  console.log(
    `wall ${(wallMs / 60_000).toFixed(1)} min with ${String(width)} files at a time`,
  );
}

function filesToRun(): string[] {
  const named = process.argv.slice(2);
  return named.length > 0 ? named : globSync("e2e/**/*.test.ts", { cwd: ROOT }).sort();
}

function watchSignals(suite: Suite): void {
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => {
      suite.stop(signal);
    });
  }
}

function conclude(
  suite: Suite,
  outcomes: readonly Outcome[],
  after: Swept,
): number {
  const bad = outcomes.filter(failed).length;
  const swept = outcomes.reduce((sum, outcome) => sum + outcome.swept.length, after.named.length);
  const stuck = outcomes.reduce((sum, outcome) => sum + outcome.stuck, after.survivors);
  console.log(
    suite.interrupted
      ? "interrupted"
      : `${String(bad)} files failed, ${String(swept)} leftover processes swept, ${String(stuck)} could not be killed`,
  );
  return suite.interrupted || bad > 0 || stuck > 0 ? 1 : 0;
}

async function main(): Promise<number> {
  const width = concurrency();
  const files = filesToRun();
  if (files.length === 0) {
    console.error("no end-to-end test files");
    return 1;
  }
  const suite = new Suite(runBase());
  const began = Date.now();
  const deadline = setTimeout(() => {
    console.error(`End-to-end suite exceeded ${String(SUITE_MINUTES)} minutes`);
    suite.stop("SIGKILL");
  }, SUITE_MINUTES * 60_000);
  watchSignals(suite);
  let after: Swept;
  try {
    console.log(`${String(files.length)} files, ${String(width)} at a time, in ${suite.dir}`);
    await suite.run(files, width);
  } finally {
    try {
      after = await suite.finish();
      for (const line of after.named) console.log(`swept after the suite: ${line}`);
    } finally {
      clearTimeout(deadline);
      summarize(suite, Date.now() - began, width);
    }
  }
  return conclude(suite, suite.outcomes, after);
}

process.exitCode = await main();
