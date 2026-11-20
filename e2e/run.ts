import type { ChildProcess } from "node:child_process";
import {
  closeSync,
  existsSync,
  globSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  GROUPS_ENV,
  groupIdentity,
  groupScopes,
  openGroupScope,
  signalOwnedGroup,
  spawnOwned,
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
const DURATIONS = join(ROOT, "e2e", "durations.json");
const COUNT_FIELDS = ["tests", "pass", "fail", "cancelled", "skipped"];

interface Outcome {
  readonly file: string;
  readonly ms: number;
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly swept: readonly string[];
  readonly unresolved: readonly number[];
  readonly retained: boolean;
  readonly counts: Readonly<Record<string, number>> | undefined;
  readonly log: string;
}

const failed = (outcome: Outcome): boolean =>
  outcome.code !== 0 || outcome.timedOut || outcome.unresolved.length > 0 || outcome.retained;

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

function watchChild(child: ChildProcess, identity: string | undefined) {
  const result = Promise.withResolvers<[number | null, NodeJS.Signals | null]>();
  let timedOut = false;
  let abandoned = false;
  let escalation: ReturnType<typeof setTimeout> | undefined;
  let abandon: ReturnType<typeof setTimeout> | undefined;
  const stop = (signal: NodeJS.Signals): void => {
    signalOwnedGroup(child.pid, identity, signal);
    if (signal === "SIGKILL") {
      if (abandon !== undefined) return;
      child.kill("SIGKILL");
      abandon = setTimeout(() => {
        abandoned = true;
        child.unref();
        result.resolve([null, null]);
      }, TERM_GRACE_MS);
    } else {
      if (identity === undefined) child.kill(signal);
      escalation ??= setTimeout(() => {
        stop("SIGKILL");
      }, TERM_GRACE_MS);
    }
  };
  const deadline = setTimeout(() => {
    timedOut = true;
    stop("SIGKILL");
  }, FILE_MINUTES * 60_000);
  child.once("error", () => {
    result.resolve([1, null]);
  });
  child.once("exit", (code, signal) => {
    result.resolve([code, signal]);
  });
  const exited = result.promise.then(([code, signal]) => {
    clearTimeout(deadline);
    clearTimeout(escalation);
    clearTimeout(abandon);
    return { code, signal, timedOut, abandoned };
  });
  return { stop, exited };
}

function report(outcome: Outcome): void {
  const seconds = (outcome.ms / 1000).toFixed(1).padStart(6);
  console.log(`${failed(outcome) ? "FAIL" : "ok  "} ${seconds}s ${outcome.file}`);
  for (const line of outcome.swept) console.log(`swept after ${outcome.file}: ${line}`);
  for (const pid of outcome.unresolved)
    console.error(`unresolved after ${outcome.file}: ${String(pid)} process group`);
  if (outcome.retained) console.error(`kept run root after ${outcome.file}: unresolved ownership`);
  if (!failed(outcome)) return;
  const why = outcome.timedOut
    ? `timed out after ${String(FILE_MINUTES)} minutes`
    : `exit ${String(outcome.code)}${outcome.signal === null ? "" : ` (${outcome.signal})`}`;
  console.log(`----- ${outcome.file}: ${why}\n${outcome.log}\n----- end of ${outcome.file}`);
}

class Suite {
  readonly dir: string;
  private readonly scopes = new Set<string>();
  private readonly running = new Set<ReturnType<typeof watchChild>>();
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
    for (const child of this.running) child.stop(signal);
  }

  async finish(): Promise<Swept & { retained: boolean }> {
    const remaining = await Promise.all([...this.scopes].map((scope) => sweepGroups(scope, 0)));
    const unresolved = [...new Set(remaining.flatMap((result) => result.unresolved))];
    const retained =
      unresolved.length > 0 ||
      [...this.scopes].some((scope) => existsSync(join(dirname(scope), "unresolved-groups")));
    if (retained) console.error(`unresolved process ownership; kept ${this.dir}`);
    else rmSync(this.dir, { recursive: true, force: true });
    return { named: remaining.flatMap((result) => result.named), unresolved, retained };
  }

  private async runFile(file: string): Promise<Outcome> {
    const index = this.started++;
    const root = join(this.dir, String(index));
    mkdirSync(root, { mode: 0o700 });
    const scope = join(root, "groups");
    mkdirSync(scope, { mode: 0o700 });
    openGroupScope(scope);
    this.scopes.add(scope);
    const env = {
      ...process.env,
      FLEET_E2E_ROOT: root,
      FLEET_E2E_TMPDIR: this.dir,
      [GROUPS_ENV]: JSON.stringify([...groupScopes(), scope]),
      FLEET_E2E_DETACH: fileURLToPath(new URL("./support/owned-launch.ts", import.meta.url)),
      FORCE_COLOR: "0",
    };
    const logPath = `${root}.log`;
    const fd = openSync(logPath, "wx", 0o600);
    const began = Date.now();
    const { code, signal, timedOut, abandoned, identity } = await (async () => {
      try {
        const child = spawnOwned(
          process.execPath,
          ["--test", `--test-timeout=${String(TEST_TIMEOUT_MS)}`, "--test-reporter=spec", file],
          { cwd: ROOT, env, stdio: ["ignore", fd, fd] },
        );
        if (child.pid !== undefined) this.launched++;
        const identity = child.pid === undefined ? undefined : groupIdentity(child.pid);
        const watched = watchChild(child, identity);
        this.running.add(watched);
        try {
          return { ...(await watched.exited), identity };
        } finally {
          this.running.delete(watched);
        }
      } finally {
        closeSync(fd);
      }
    })();
    if (abandoned || identity === undefined) this.retain(root);
    const { named, unresolved } = await sweepGroups(scope, LEFTOVER_GRACE_MS);
    const retained = existsSync(join(root, "unresolved-groups"));
    const log = readFileSync(logPath, "utf8");
    if (unresolved.length === 0 && !retained) {
      rmSync(logPath, { force: true });
      rmSync(root, { recursive: true, force: true });
      this.scopes.delete(scope);
    }
    const clean = code === 0 && !timedOut && unresolved.length === 0 && !retained;
    return {
      file,
      ms: Date.now() - began,
      code,
      signal,
      timedOut,
      swept: named,
      unresolved,
      retained,
      counts: countsIn(log),
      log: clean ? "" : log,
    };
  }

  private retain(root: string): void {
    writeFileSync(join(root, "unresolved-groups"), "", { mode: 0o600 });
  }
}

function summarize(suite: Suite, wallMs: number, width: number): void {
  const { outcomes, missingFooters } = suite;
  const total = (name: string): number =>
    outcomes.reduce((sum, outcome) => sum + (outcome.counts?.[name] ?? 0), 0);
  const partial =
    missingFooters === 0 ? "" : ` (partial counts: ${String(missingFooters)} missing footers)`;
  console.log(
    `\n${String(outcomes.length)} files, ${String(total("tests"))} tests, ${String(total("pass"))} passed, ${String(total("fail"))} failed, ${String(total("cancelled"))} cancelled, ${String(total("skipped"))} skipped${partial}`,
  );
  console.log(`wall ${(wallMs / 60_000).toFixed(1)} min with ${String(width)} files at a time`);
}

function costOf(): (file: string) => number {
  const parsed: unknown = JSON.parse(readFileSync(DURATIONS, "utf8"));
  if (typeof parsed !== "object" || parsed === null)
    throw new Error(`${DURATIONS} is not an object`);
  const known = new Map<string, number>();
  for (const [file, seconds] of Object.entries(parsed)) {
    if (typeof seconds !== "number") throw new Error(`${DURATIONS} has no number for ${file}`);
    known.set(file, seconds);
  }
  const typical = [...known.values()].sort((a, b) => a - b)[Math.floor(known.size / 2)] ?? 0;
  return (file) => known.get(file) ?? typical;
}

function balanced(files: readonly string[], count: number): string[][] {
  const cost = costOf();
  const bins = Array.from({ length: count }, () => ({ load: 0, files: new Array<string>() }));
  for (const file of [...files].sort((a, b) => cost(b) - cost(a) || a.localeCompare(b))) {
    const bin = bins.reduce((least, each) => (each.load < least.load ? each : least));
    bin.load += cost(file);
    bin.files.push(file);
  }
  return bins.map((bin) => bin.files);
}

function filesToRun(): string[] {
  const shard = process.argv.find((arg) => arg.startsWith("--shard="));
  const found = /^--shard=([1-9]\d*)\/([1-9]\d*)$/.exec(shard ?? "--shard=1/1");
  const index = Number(found?.[1]);
  const count = Number(found?.[2]);
  if (found === null || index > count) throw new Error("--shard must be N/M with N from 1 to M");
  const named = process.argv.slice(2).filter((arg) => arg !== shard);
  const files = (named.length > 0 ? named : ["e2e/**/*.test.ts"]).flatMap((pattern) =>
    globSync(pattern, { cwd: ROOT }),
  );
  return balanced(files, count)[index - 1] ?? [];
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
  after: Swept & { retained: boolean },
): number {
  const bad = outcomes.filter(failed).length;
  const swept = new Set([...outcomes.flatMap((outcome) => outcome.swept), ...after.named]);
  console.log(
    `${suite.interrupted ? "interrupted; " : ""}${String(bad)} files failed, ${String(swept.size)} leftover groups removed, ${String(after.unresolved.length)} groups unresolved`,
  );
  return suite.interrupted || bad > 0 || after.retained ? 1 : 0;
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
  let after: Awaited<ReturnType<Suite["finish"]>>;
  try {
    console.log(`${String(files.length)} files, ${String(width)} at a time, in ${suite.dir}`);
    await suite.run(files, width);
  } finally {
    try {
      after = await suite.finish();
      for (const line of after.named) console.log(`swept after the suite: ${line}`);
      for (const pid of after.unresolved)
        console.error(`unresolved after the suite: ${String(pid)} process group`);
    } finally {
      clearTimeout(deadline);
      summarize(suite, Date.now() - began, width);
    }
  }
  return conclude(suite, suite.outcomes, after);
}

process.exitCode = await main();
