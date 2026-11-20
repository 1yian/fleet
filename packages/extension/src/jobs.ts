import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { check, OPS, type Entry } from "@fleet/protocol";
import { quote } from "@fleet/protocol/route";
import Type from "typebox";
import { joinContained } from "./containment.ts";
import { field, herdr, records, rootPane } from "./host.ts";
import { confirmLegacyStop, jobHandshake } from "./job-http.ts";
import type { Link } from "./link.ts";
import { forwardedEnvironment, hostDir } from "./scratch.ts";

const WRAPPER = fileURLToPath(new URL("./job.ts", import.meta.url));
const DEFAULT_TIMEOUT_MINUTES = 60;
const PREPARE_ATTEMPTS = 3;
const TAB_CLOSE_ATTEMPTS = 3;

const RunLongParams = Type.Object({
  label: Type.String({ pattern: "^[A-Za-z0-9._-]+$", description: "A short name, such as tests" }),
  command: Type.String({
    minLength: 1,
    description:
      "Runs in bash -o pipefail without errexit. Pipelines fail if any stage fails. WARNING: a command list returns its last command's status: 'false; true' succeeds. Use 'suite && formatter', or 'suite; code=$?; formatter; exit \"$code\"'. Intentional recovery with || and if keeps normal Bash semantics. Nested shells own their failure policy.",
  }),
  timeout_minutes: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 120 })),
});

const StopJobParams = Type.Object({
  job: Type.Integer({ description: "The number of one of your own run_long jobs" }),
});

const DropJobParams = Type.Object({
  job: Type.Integer({ description: "The number of a lost job" }),
});

export function registerDropJob(pi: ExtensionAPI, link: Link): void {
  pi.registerTool({
    name: "drop_job",
    label: "Drop job",
    description:
      "Drops one lost job by its number, so its reminders stop. A worker drops its own lost job. A mate drops a lost job of a card in its lane. The job stays recorded as lost. A job that is running is refused: use stop_job. Dropping twice is safe.",
    parameters: DropJobParams,
    execute: async (_id, params) => {
      const { label, state, dropped } = await link.call("job.drop", { job: params.job });
      const named = `job ${String(params.job)} (${label})`;
      const text = dropped
        ? `${named} is dropped. It stays recorded as lost, and its reminders stop.`
        : `${named} is ${state}, not lost: nothing to drop.`;
      return { content: [{ type: "text", text }], details: {} };
    },
  });
}

const tabName = (job: number, label: string): string => `job-${String(job)}-${label}`;

interface JobOptions {
  readonly timeoutMs: number;
  readonly tailLines?: number;
  readonly lineChars?: number;
}

interface PendingDispatch {
  readonly launch: string;
  readonly file: string;
  dispatched: boolean;
  fenced: boolean;
}

const startupFenced = (pending: PendingDispatch | undefined): boolean => pending?.fenced === true;

interface Preparing {
  fence?: { job: number; detail: string };
}

export class Jobs {
  private readonly preparing = new Map<string, Preparing>();
  private readonly running = new Set<number>();
  private readonly lastResult = new Map<number, number>();
  private readonly pending = new Map<number, PendingDispatch>();
  private readonly launching = new Map<
    number,
    { unstarted: boolean; ran: boolean; legacy: boolean }
  >();
  private readonly unsettled = new Set<number>();
  private readonly ownedTabs = new Map<number, string>();
  private readonly link: Link;
  private readonly endpoint: { url: string; token: string };
  private readonly warn: (text: string) => void;

  constructor(link: Link, cardd: { url: string; token: string }, warn: (text: string) => void) {
    this.link = link;
    this.endpoint = {
      ...cardd,
      url: cardd.url.replace(/^ws/, "http").replace(/\/session$/, "/call"),
    };
    this.warn = warn;
  }

  get waiting(): boolean {
    return this.running.size > 0 || [...this.pending.values()].some(({ dispatched }) => dispatched);
  }

  async sync(): Promise<void> {
    this.resumeLaunchCleanup();
    const jobs = await this.link.call("jobs", {}, 5000);
    for (const { id } of jobs) {
      if (this.lastResult.has(id)) continue;
      this.running.add(id);
      this.clearPending(id);
    }
  }

  observeResult(entry: Entry): void {
    const { job, startupFenced, startupLaunch, exitCode, lost, revived } = entry.fields;
    if (typeof job !== "number" || (this.lastResult.get(job) ?? 0) >= entry.id) return;
    if (startupFenced !== true && typeof exitCode !== "number" && lost !== true && revived !== true)
      return;
    this.lastResult.set(job, entry.id);
    if (startupFenced === true) {
      this.confirmStartupFence(
        job,
        typeof startupLaunch === "string" ? startupLaunch : undefined,
        entry.body,
      );
      return;
    }
    if (lost === true || typeof exitCode === "number") this.settleLaunchFile(job);
    const launching = this.launching.get(job);
    if (launching !== undefined && entry.fields["commandNotStarted"] === true)
      launching.unstarted = true;
    else if (
      launching !== undefined &&
      typeof exitCode === "number" &&
      (!launching.legacy || exitCode === 0)
    )
      launching.ran = true;
    this.clearPending(job);
    if (revived === true) this.running.add(job);
    else this.running.delete(job);
    if (typeof exitCode === "number") this.forgetTab(job);
  }

  private owner(job: number): string {
    return createHash("sha256")
      .update(`${this.endpoint.token}:${String(job)}`)
      .digest("hex")
      .slice(0, 32);
  }

  private legacyLaunchName(job: number): string {
    return `fleet-job-${String(job)}-${this.owner(job)}.json`;
  }

  private ownerDir(): string {
    const owner = createHash("sha256").update(this.endpoint.token).digest("hex").slice(0, 32);
    return join(hostDir(), "job-launch-files", owner);
  }

  private launchRecord(job: number): string {
    return join(this.ownerDir(), `${String(job)}.path`);
  }

  private pendingRecord(job: number): string {
    return join(this.ownerDir(), `${String(job)}.pending`);
  }

  private settleLaunchFile(job: number): void {
    try {
      renameSync(this.launchRecord(job), this.pendingRecord(job));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        const why = error instanceof Error ? error.message : String(error);
        this.unsettled.add(job);
        this.warn(`Job ${String(job)}'s launch record could not be marked for removal: ${why}`);
        return;
      }
    }
    this.cleanLaunchFile(job);
  }

  private cleanLaunchFile(job: number): void {
    const marker = this.pendingRecord(job);
    let file: string;
    try {
      file = readFileSync(marker, "utf8").trim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        const why = error instanceof Error ? error.message : String(error);
        this.warn(`Job ${String(job)}'s launch record ${marker} could not be read: ${why}`);
      }
      return;
    }
    if (!isAbsolute(file) || basename(file) !== this.legacyLaunchName(job)) {
      this.warn(`Job ${String(job)}'s launch record ${marker} does not name its launch file`);
      return;
    }
    if (this.removeFile(job, file)) this.removeFile(job, marker);
  }

  private resumeLaunchCleanup(): void {
    for (const job of [...this.unsettled]) {
      this.unsettled.delete(job);
      this.settleLaunchFile(job);
    }
    let names: string[];
    try {
      names = readdirSync(this.ownerDir());
    } catch {
      return;
    }
    for (const name of names) {
      const match = /^(\d+)\.pending$/.exec(name);
      if (match?.[1] !== undefined) this.cleanLaunchFile(Number(match[1]));
    }
  }

  private removeFile(job: number, file: string): boolean {
    try {
      rmSync(file, { force: true });
      return true;
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      this.warn(`Job ${String(job)}'s launch file ${file} could not be removed: ${why}`);
      return false;
    }
  }

  private forgetTab(job: number): void {
    this.ownedTabs.delete(job);
  }

  private confirmStartupFence(job: number, launch?: string, detail = "startup was fenced"): void {
    if (launch !== undefined) {
      const preparing = this.preparing.get(launch);
      if (preparing !== undefined) preparing.fence = { job, detail };
    }
    const pending = this.pending.get(job);
    if (pending !== undefined && launch !== undefined && pending.launch !== launch) return;
    this.running.delete(job);
    if (pending === undefined) return;
    pending.fenced = true;
    this.clearPending(job);
    const tab = this.ownedTabs.get(job);
    if (tab !== undefined) {
      this.forgetTab(job);
      void this.closeStartupTab(job, tab);
    }
  }

  private clearPending(job: number): void {
    const pending = this.pending.get(job);
    if (pending === undefined) return;
    this.pending.delete(job);
    this.removeFile(job, pending.file);
  }

  private async closeStartupTab(job: number, tab: string): Promise<void> {
    for (let attempt = 1; attempt <= TAB_CLOSE_ATTEMPTS; attempt += 1) {
      try {
        await herdr("local", ["tab", "close", tab]);
        return;
      } catch (error) {
        if (attempt === TAB_CLOSE_ATTEMPTS) {
          const why = error instanceof Error ? error.message : String(error);
          this.warn(
            `Job ${String(job)} did not start, but its tab ${tab} could not be closed: ${why}`,
          );
        } else await delay(200);
      }
    }
  }

  private async prepare(
    id: string,
    label: string,
    command: string,
  ): Promise<{ job: number; heartbeatMs: number; registeredLaunch: boolean }> {
    const args = { launch: id, label, command };
    for (let attempt = 0; attempt < PREPARE_ATTEMPTS; attempt += 1) {
      const receipt = await jobHandshake(this.endpoint, "job.prepare", args)
        .then((reply) =>
          reply.ok ? { ...reply, value: check(OPS["job.prepare"].result, reply.value) } : reply,
        )
        .catch(() => undefined);
      if (receipt === undefined) continue;
      if (receipt.ok) {
        if ("unavailable" in receipt.value)
          throw new Error(
            `Job ${String(receipt.value.job)} cannot start: ${receipt.value.unavailable}`,
          );
        return { ...receipt.value, registeredLaunch: true };
      }
      if (
        attempt === 0 &&
        receipt.status === 400 &&
        receipt.error === "unknown operation job.prepare"
      )
        return {
          ...(await this.link.call("job.start", { label, command })),
          registeredLaunch: false,
        };
      throw new Error(receipt.error);
    }
    throw new Error(`Could not confirm the reservation for ${label}; no command was launched`);
  }

  async launch(
    label: string,
    command: string,
    options: JobOptions,
  ): Promise<{ job: number; tab: string; started: boolean }> {
    const workspace = process.env["HERDR_WORKSPACE_ID"];
    if (workspace === undefined) throw new Error(`${label} needs a worker inside a herdr pane`);
    this.resumeLaunchCleanup();
    const id = randomUUID();
    const preparing: Preparing = {};
    this.preparing.set(id, preparing);
    const { job, heartbeatMs, registeredLaunch } = await this.prepare(id, label, command).catch(
      (error: unknown) => {
        this.preparing.delete(id);
        throw error;
      },
    );
    this.preparing.delete(id);
    if (registeredLaunch && preparing.fence?.job === job)
      throw new Error(`Job ${String(job)} cannot start: ${preparing.fence.detail}`);
    const file = join(
      resolve(tmpdir()),
      registeredLaunch ? `fleet-job-${String(job)}-${id}.json` : this.legacyLaunchName(job),
    );
    const tab = tabName(job, label);
    const pending: PendingDispatch | undefined = registeredLaunch
      ? { launch: id, file, dispatched: false, fenced: false }
      : undefined;
    const launching = { unstarted: false, ran: false, legacy: !registeredLaunch };
    this.launching.set(job, launching);
    let dispatched = false;
    try {
      const { timeoutMs, tailLines, lineChars } = options;
      const body = {
        ...this.endpoint,
        job,
        ...(registeredLaunch ? { launch: { id, command } } : { command }),
        timeoutMs,
        heartbeatMs,
        tailLines,
        lineChars,
      };
      if (!registeredLaunch) {
        mkdirSync(this.ownerDir(), { recursive: true });
        writeFileSync(this.launchRecord(job), file, { mode: 0o600 });
      }
      writeFileSync(file, JSON.stringify(body), { mode: 0o600 });
      if (pending !== undefined) this.pending.set(job, pending);
      const created = await herdr("local", [
        "tab",
        "create",
        "--workspace",
        workspace,
        "--cwd",
        process.cwd(),
        "--label",
        tab,
        "--no-focus",
        ...forwardedEnvironment(process.env).flatMap((pair) => ["--env", pair]),
      ]);
      const tabId = field(records([created["tab"]])[0], "tab_id");
      if (pending !== undefined) {
        if (tabId === undefined) throw new Error("herdr did not return the job tab ID");
        if (pending.fenced) {
          void this.closeStartupTab(job, tabId);
          throw new Error(`Job ${String(job)} was fenced before dispatch`);
        }
      }
      if (tabId !== undefined) this.ownedTabs.set(job, tabId);
      const pane = rootPane(created);
      await joinContained("local", pane, process.cwd());
      if (startupFenced(pending)) throw new Error(`Job ${String(job)} was fenced before dispatch`);
      if (launching.legacy && this.lastResult.has(job))
        throw new Error(`Job ${String(job)} was reported lost before dispatch; nothing was run`);
      if (pending !== undefined) pending.dispatched = true;
      else if (!this.lastResult.has(job)) this.running.add(job);
      dispatched = true;
      const paneFailure = await herdr("local", [
        "pane",
        "run",
        pane,
        `node ${quote(WRAPPER)} ${quote(file)}`,
      ]).then(
        () => undefined,
        (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
      );
      if (startupFenced(pending)) throw new Error(`Job ${String(job)} was fenced during dispatch`);
      if (launching.unstarted)
        throw new Error(
          `Job ${String(job)} did not start: its wrapper reported that the command never ran`,
        );
      if (paneFailure !== undefined) throw paneFailure;
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      if (startupFenced(pending) || launching.unstarted) throw error;
      if (launching.ran) return { job, tab, started: true };
      if (dispatched)
        throw new Error(
          `Could not confirm dispatch for job ${String(job)}; its result, loss, or failed startup arrives as a [fleet] message: ${why}`,
          { cause: error },
        );
      if (registeredLaunch) this.removeFile(job, file);
      else this.settleLaunchFile(job);
      const outputTail = `could not start: ${why}`;
      this.running.delete(job);
      const finished = await this.link
        .call("job.finish", {
          job,
          exitCode: 127,
          outputTail,
          ...(registeredLaunch ? { beforeRegistration: id } : {}),
        })
        .catch(() => undefined);
      if (finished?.recorded === true) {
        if (!this.lastResult.has(job)) this.lastResult.set(job, 0);
        if (pending !== undefined) this.confirmStartupFence(job);
      }
      if (pending === undefined) this.forgetTab(job);
      throw error;
    } finally {
      if (this.launching.get(job) === launching) this.launching.delete(job);
    }
    return { job, tab, started: launching.ran };
  }

  async stop(job: number): Promise<string> {
    const workspace = process.env["HERDR_WORKSPACE_ID"];
    if (workspace === undefined) throw new Error("stop_job needs a worker inside a herdr pane");
    const before = this.lastResult.get(job);
    const { label, running, cancelled, legacy } = await this.link.call("job.stop", { job });
    const named = `job ${String(job)} (${label})`;
    if (!running) {
      if (this.lastResult.get(job) === before) {
        if (before === undefined) this.lastResult.set(job, 0);
        this.running.delete(job);
        if (cancelled === true) this.confirmStartupFence(job);
      }
      return cancelled === true
        ? `${named} was stopped before wrapper registration. Its command will not run.`
        : `${named} is not running: nothing to stop.`;
    }
    let tab = this.ownedTabs.get(job);
    if (tab === undefined) {
      if (legacy !== true && !(await confirmLegacyStop(this.endpoint, job, label)))
        return `${named} has no verified tab ID in this worker session, so nothing was signalled.`;
      const tabs = records(
        (await herdr("local", ["tab", "list", "--workspace", workspace]))["tabs"],
      );
      const matches = tabs.filter((each) => each["label"] === tabName(job, label));
      if (matches.length > 1)
        return `${named} has multiple matching tabs and no known tab ID, so nothing was signalled.`;
      tab = field(matches[0], "tab_id");
    }
    const panes = records(
      (await herdr("local", ["pane", "list", "--workspace", workspace]))["panes"],
    );
    const pane = field(
      panes.find((each) => tab !== undefined && each["tab_id"] === tab),
      "pane_id",
    );
    if (pane === undefined)
      return `${named} has no tab left in your workspace, so nothing was signalled. If it is still recorded as running, it is reported lost soon.`;
    await herdr("local", ["pane", "send-keys", pane, "ctrl+c"]);
    return `Sent a stop to ${named}. Its result arrives as a [fleet] message, exited 130 when the stop took.`;
  }

  register(pi: ExtensionAPI): void {
    pi.registerTool({
      name: "run_long",
      label: "Run long",
      description:
        "Runs a long command in its own herdr tab and returns at once. The result arrives later as a [fleet] message. You may end your run while it runs. It stops the command after timeout_minutes (default 60 minutes, maximum 120 minutes / 2 hours), so never wrap the command in timeout or gtimeout.",
      parameters: RunLongParams,
      execute: async (_id, params) => {
        const { label, command } = params;
        const timeoutMs = (params.timeout_minutes ?? DEFAULT_TIMEOUT_MINUTES) * 60_000;
        const { job, tab, started } = await this.launch(label, command, { timeoutMs });
        const text = started
          ? `Started job ${String(job)} (${label}) in tab ${tab}. Its result arrives as a [fleet] message; you may end this run.`
          : `Dispatched job ${String(job)} (${label}) in tab ${tab}; its startup is not yet confirmed. Its result, or a failure to start, arrives as a [fleet] message; you may end this run.`;
        return { content: [{ type: "text", text }], details: {} };
      },
    });
    pi.registerTool({
      name: "stop_job",
      label: "Stop job",
      description:
        "Stops one of your own run_long jobs by its number. The job's wrapper ends only that job's processes, and its result arrives later as a [fleet] message. A job that is not yours is refused and nothing is signalled. Never stop anything with pkill, killall, or a pgrep list: other workers share the host.",
      parameters: StopJobParams,
      execute: async (_id, params) => ({
        content: [{ type: "text", text: await this.stop(params.job) }],
        details: {},
      }),
    });
  }
}
