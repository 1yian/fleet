import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { JobResultFields, StartupFenceFields, type Entry } from "@fleet/protocol";
import type { Static } from "typebox";
import Value from "typebox/value";
import { joinContained } from "./containment.ts";
import { field, herdr, records } from "./host.ts";
import { JobFiles } from "./job-files.ts";
import {
  CALL_DEADLINE_MS,
  closeJobTab,
  createJobTab,
  present,
  prepareJob,
  runWrapper,
} from "./job-launch.ts";
import type { Link } from "./link.ts";
import { registerJobTools } from "./job-tools.ts";

const tabName = (job: number, label: string): string => `job-${String(job)}-${label}`;

interface JobOptions {
  readonly timeoutMs: number;
  readonly tailLines?: number;
  readonly lineChars?: number;
}

interface PendingDispatch {
  readonly file: string;
  dispatched: boolean;
  fenced: boolean;
}

const startupFenced = (pending: PendingDispatch | undefined): boolean => pending?.fenced === true;

interface Preparing {
  readonly fences: Map<number, Entry>;
}

interface LaunchResult {
  job: number;
  tab: string;
  started: boolean;
}

interface Reservation {
  id: string;
  command: string;
  job: number;
  heartbeatMs: number;
  registeredLaunch: boolean;
}

interface LaunchRun extends Reservation {
  workspace: string;
  options: JobOptions;
  file: string;
  tab: string;
  pending: PendingDispatch | undefined;
  launching: { unstarted: boolean; ran: boolean; legacy: boolean };
  dispatched: boolean;
}

const supersededReply = (named: string): string =>
  `${named}: no interrupt was sent, and this reply was superseded by newer news about the job.`;

export class Jobs {
  private readonly preparing = new Map<string, Preparing>();
  private readonly launches = new Map<number, string>();
  private readonly running = new Set<number>();
  private readonly lastResult = new Map<number, number>();
  private readonly revisions = new Map<number, number>();
  private readonly unresolved = new Set<number>();
  private readonly pending = new Map<number, PendingDispatch>();
  private readonly launching = new Map<
    number,
    { unstarted: boolean; ran: boolean; legacy: boolean }
  >();
  private readonly files: JobFiles;
  private readonly cancelledJobs = new Set<number>();
  private readonly ownedTabs = new Map<number, string>();
  private readonly dispatchPanes = new Map<number, string>();
  private readonly link: Link;
  private readonly endpoint: { url: string; token: string };
  private readonly warn: (text: string) => void;
  private readonly onWaitChanged: () => void;

  constructor(
    link: Link,
    cardd: { url: string; token: string },
    warn: (text: string) => void,
    onWaitChanged: () => void,
  ) {
    this.link = link;
    this.endpoint = {
      ...cardd,
      url: cardd.url.replace(/^ws/, "http").replace(/\/session$/, "/call"),
    };
    this.warn = warn;
    this.onWaitChanged = onWaitChanged;
    this.files = new JobFiles(cardd.token, warn);
  }

  get waiting(): boolean {
    return this.running.size > 0 || [...this.pending.values()].some(({ dispatched }) => dispatched);
  }

  async sync(): Promise<void> {
    this.files.resumeLaunchCleanup();
    const retry = Promise.all([...this.unresolved].map((job) => this.reconcile(job)));
    const before = new Map(this.revisions);
    try {
      const jobs = await this.link.call("jobs", {}, CALL_DEADLINE_MS);
      const wasWaiting = this.waiting;
      for (const { id } of jobs) {
        if (this.revisions.get(id) !== before.get(id)) continue;
        this.running.add(id);
        this.launches.delete(id);
        this.clearPending(id);
      }
      if (this.waiting !== wasWaiting) this.onWaitChanged();
    } finally {
      await retry;
    }
  }

  private advance(job: number): void {
    this.revisions.set(job, (this.revisions.get(job) ?? 0) + 1);
  }

  private async reconcile(job: number): Promise<void> {
    this.unresolved.add(job);
    const seen = this.revisions.get(job);
    const result = this.lastResult.get(job);
    let running: boolean;
    try {
      running = (await this.link.call("job.running", { job }, CALL_DEADLINE_MS)).running;
    } catch {
      return;
    }
    if (this.revisions.get(job) !== seen || this.lastResult.get(job) !== result) return;
    this.advance(job);
    this.unresolved.delete(job);
    const wasWaiting = this.waiting;
    if (running) {
      this.clearPending(job);
      this.running.add(job);
      this.launches.delete(job);
    } else {
      this.running.delete(job);
      const pending = this.pending.get(job);
      if (pending !== undefined) pending.dispatched = false;
    }
    if (this.waiting !== wasWaiting) this.onWaitChanged();
  }

  observeResult(entry: Entry): void {
    const { fields } = entry;
    if ("startupFenced" in fields || "startupLaunch" in fields) this.observeFence(entry);
    else if (Value.Check(JobResultFields, fields)) this.applyResult(entry.id, fields);
    else if (["exitCode", "lost", "revived", "commandNotStarted"].some((key) => key in fields))
      this.warn(`Ignored an incomplete job result (entry ${String(entry.id)})`);
  }

  private noteLaunching(fields: Static<typeof JobResultFields>): void {
    const { job, exitCode, commandNotStarted } = fields;
    const launching = this.launching.get(job);
    if (launching === undefined) return;
    if (commandNotStarted === true) launching.unstarted = true;
    else if (typeof exitCode === "number" && (!launching.legacy || exitCode !== 127))
      launching.ran = true;
  }

  private applyResult(id: number, fields: Static<typeof JobResultFields>): void {
    const { job, exitCode, lost, revived } = fields;
    if ((this.lastResult.get(job) ?? 0) >= id) return;
    if (lost === true || revived === true) this.launches.delete(job);
    this.lastResult.set(job, id);
    const finished = typeof exitCode === "number";
    if (finished) {
      this.advance(job);
      this.unresolved.delete(job);
    }
    if (lost === true || finished) this.files.settleLaunchFile(job);
    this.noteLaunching(fields);
    if (!finished) {
      void this.reconcile(job);
      return;
    }
    this.launches.delete(job);
    this.clearPending(job);
    this.running.delete(job);
    this.forgetTab(job);
  }

  private forgetTab(job: number): void {
    this.ownedTabs.delete(job);
    this.dispatchPanes.delete(job);
  }

  private observeFence(entry: Entry): void {
    if (!Value.Check(StartupFenceFields, entry.fields)) {
      this.warn(`Ignored an incomplete startup fence (entry ${String(entry.id)})`);
      return;
    }
    const { job } = entry.fields;
    if ((this.lastResult.get(job) ?? 0) >= entry.id) return;
    const launch = entry.fields.startupLaunch;
    if (this.launches.get(job) !== launch) {
      this.preparing.get(launch)?.fences.set(job, entry);
      return;
    }
    this.lastResult.set(job, entry.id);
    this.advance(job);
    this.unresolved.delete(job);
    this.confirmStartupFence(job);
  }

  private confirmStartupFence(job: number): void {
    this.launches.delete(job);
    const pending = this.pending.get(job);
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
    this.files.removeFile(job, pending.file);
  }

  private closeStartupTab(job: number, tab: string): Promise<void> {
    return closeJobTab(this.warn, job, tab);
  }

  private async bindTab(
    job: number,
    created: Record<string, unknown>,
    workspace: string,
    pending: PendingDispatch | undefined,
  ): Promise<{ tabId: string; pane: string }> {
    const tabId = present(field(records([created["tab"]])[0], "tab_id"), "tab ID");
    const pane = field(records([created["root_pane"]])[0], "pane_id");
    if (pane === undefined || pane.trim() === "") {
      if (pending?.fenced === true) void this.closeStartupTab(job, tabId);
      else this.ownedTabs.set(job, tabId);
      throw new Error("herdr did not return the job pane ID");
    }
    const listed = records(
      (await herdr("local", ["pane", "list", "--workspace", workspace]))["panes"],
    );
    if (!listed.some((each) => each["pane_id"] === pane && each["tab_id"] === tabId))
      throw new Error("herdr returned a root pane outside the job tab");
    if (pending?.fenced === true) {
      void this.closeStartupTab(job, tabId);
      throw new Error(`Job ${String(job)} was fenced before dispatch`);
    }
    this.ownedTabs.set(job, tabId);
    return { tabId, pane };
  }

  private async reserve(label: string, command: string): Promise<Reservation> {
    const id = randomUUID();
    const preparing: Preparing = { fences: new Map() };
    this.preparing.set(id, preparing);
    const prepared = await prepareJob(this.endpoint, this.link, id, label, command).finally(() => {
      this.preparing.delete(id);
    });
    const { job, registeredLaunch } = prepared;
    if (registeredLaunch) this.launches.set(job, id);
    const early = preparing.fences.get(job);
    if (early !== undefined) {
      this.observeResult(early);
      throw new Error(`Job ${String(job)} cannot start: ${early.body}`);
    }
    if (registeredLaunch && this.cancelledJobs.has(job))
      throw new Error(`Job ${String(job)} cannot start: it was stopped before dispatch`);
    return { ...prepared, id, command };
  }

  private begin(
    reservation: Reservation,
    label: string,
    workspace: string,
    options: JobOptions,
  ): LaunchRun {
    const { id, job, registeredLaunch } = reservation;
    const file = join(
      resolve(tmpdir()),
      registeredLaunch ? `fleet-job-${String(job)}-${id}.json` : this.files.legacyLaunchName(job),
    );
    const launching = { unstarted: false, ran: false, legacy: !registeredLaunch };
    this.launching.set(job, launching);
    if (launching.legacy && !this.lastResult.has(job)) this.running.add(job);
    return {
      ...reservation,
      workspace,
      options,
      file,
      tab: tabName(job, label),
      pending: registeredLaunch ? { file, dispatched: false, fenced: false } : undefined,
      launching,
      dispatched: false,
    };
  }

  private writeLaunchFile(run: LaunchRun): void {
    const { job, id, command, heartbeatMs, registeredLaunch, file, pending, options } = run;
    const body = {
      ...this.endpoint,
      job,
      ...(registeredLaunch ? { launch: { id, command } } : { command }),
      timeoutMs: options.timeoutMs,
      heartbeatMs,
      tailLines: options.tailLines,
      lineChars: options.lineChars,
    };
    if (!registeredLaunch) this.files.remember(job, file);
    writeFileSync(file, JSON.stringify(body), { mode: 0o600 });
    if (pending !== undefined) this.pending.set(job, pending);
  }

  private assertDispatchable(run: LaunchRun): void {
    const { job, pending, launching } = run;
    if (startupFenced(pending)) throw new Error(`Job ${String(job)} was fenced before dispatch`);
    if (launching.legacy && this.lastResult.has(job))
      throw new Error(`Job ${String(job)} was reported lost before dispatch; nothing was run`);
  }

  private assertStarted(run: LaunchRun, paneFailure: Error | undefined): void {
    const { job, pending, launching } = run;
    if (startupFenced(pending)) throw new Error(`Job ${String(job)} was fenced during dispatch`);
    if (launching.unstarted)
      throw new Error(
        `Job ${String(job)} did not start: its wrapper reported that the command never ran`,
      );
    if (paneFailure !== undefined) throw paneFailure;
  }

  private async dispatch(run: LaunchRun): Promise<void> {
    const { job, pending, file, workspace } = run;
    this.writeLaunchFile(run);
    const created = await createJobTab(workspace, run.tab);
    const { tabId, pane } = await this.bindTab(job, created, workspace, pending);
    await joinContained("local", pane, process.cwd());
    this.assertDispatchable(run);
    if (pending !== undefined) {
      pending.dispatched = true;
      this.dispatchPanes.set(job, pane);
    }
    run.dispatched = true;
    const paneFailure = await runWrapper(pane, file);
    if (paneFailure === undefined && this.ownedTabs.get(job) === tabId)
      this.dispatchPanes.set(job, pane);
    this.assertStarted(run, paneFailure);
  }

  private async recordStartFailure(run: LaunchRun, why: string): Promise<void> {
    const { job, id, file, pending } = run;
    this.files.removeFile(job, file);
    const outputTail = `could not start: ${why}`;
    this.running.delete(job);
    const finished = await this.link
      .call(
        "job.finish",
        { job, exitCode: 127, outputTail, beforeRegistration: id },
        CALL_DEADLINE_MS,
      )
      .catch(() => undefined);
    if (finished?.recorded !== true) return;
    this.advance(job);
    this.unresolved.delete(job);
    if (!this.lastResult.has(job)) this.lastResult.set(job, 0);
    if (pending !== undefined) this.confirmStartupFence(job);
  }

  private async failLaunch(run: LaunchRun, error: unknown): Promise<LaunchResult> {
    const { job, tab, pending, launching } = run;
    const why = error instanceof Error ? error.message : String(error);
    if (startupFenced(pending) || launching.unstarted) throw error;
    if (launching.ran) return { job, tab, started: true };
    if (run.dispatched)
      throw new Error(
        `Could not confirm dispatch for job ${String(job)}; its result, loss, or failed startup arrives as a [fleet] message: ${why}`,
        { cause: error },
      );
    if (launching.legacy) {
      this.files.settleLaunchFile(job);
      this.running.delete(job);
    } else await this.recordStartFailure(run, why);
    throw error;
  }

  async launch(label: string, command: string, options: JobOptions): Promise<LaunchResult> {
    const workspace = process.env["HERDR_WORKSPACE_ID"];
    if (workspace === undefined) throw new Error(`${label} needs a worker inside a herdr pane`);
    this.files.resumeLaunchCleanup();
    const reservation = await this.reserve(label, command);
    const run = this.begin(reservation, label, workspace, options);
    const { job, tab, launching } = run;
    try {
      await this.dispatch(run);
    } catch (error) {
      return await this.failLaunch(run, error);
    } finally {
      if (this.launching.get(job) === launching) this.launching.delete(job);
    }
    return { job, tab, started: launching.ran };
  }

  private settleIdleStop(
    job: number,
    cancelled: boolean,
    stale: () => boolean,
  ): { current: boolean } {
    const current = cancelled || !stale();
    if (!current) return { current };
    this.advance(job);
    if (!this.lastResult.has(job)) this.lastResult.set(job, 0);
    this.running.delete(job);
    const pending = this.pending.get(job);
    if (cancelled) this.confirmStartupFence(job);
    else if (pending !== undefined) pending.dispatched = false;
    if (this.pending.has(job)) this.unresolved.add(job);
    else this.unresolved.delete(job);
    return { current };
  }

  private async interrupt(
    job: number,
    workspace: string,
    named: string,
    stale: () => boolean,
  ): Promise<string> {
    const superseded = supersededReply(named);
    if (stale()) return superseded;
    const tab = this.ownedTabs.get(job);
    const dispatched = this.dispatchPanes.get(job);
    const refusal = (): string =>
      this.launching.has(job)
        ? `${named} is still starting in this worker, so nothing was signalled.`
        : `${named} has no verified tab ID in this worker session, so nothing was signalled. After a worker replacement its tab cannot be proven, and a tab name is never used as proof.`;
    if (tab === undefined || dispatched === undefined) return refusal();
    const panes = records(
      (await herdr("local", ["pane", "list", "--workspace", workspace]))["panes"],
    );
    if (stale()) return superseded;
    if (this.ownedTabs.get(job) !== tab || this.dispatchPanes.get(job) !== dispatched)
      return refusal();
    if (!panes.some((each) => each["tab_id"] === tab && each["pane_id"] === dispatched))
      return `${named} is no longer in the tab this worker created for it, so nothing was signalled. The job may still be running.`;
    await herdr("local", ["pane", "send-keys", dispatched, "ctrl+c"]);
    return `Sent a stop to ${named}. Its result arrives as a [fleet] message, exited 130 when the stop took.`;
  }

  async stop(job: number): Promise<string> {
    const workspace = process.env["HERDR_WORKSPACE_ID"];
    if (workspace === undefined) throw new Error("stop_job needs a worker inside a herdr pane");
    const before = this.revisions.get(job);
    const noticed = this.lastResult.get(job);
    const stale = (): boolean =>
      this.revisions.get(job) !== before || this.lastResult.get(job) !== noticed;
    const receipt = await this.link.call("job.stop", { job }, CALL_DEADLINE_MS);
    const named = `job ${String(job)} (${receipt.label})`;
    if (receipt.running) {
      this.launches.delete(job);
      return this.interrupt(job, workspace, named, stale);
    }
    const cancelled = receipt.cancelled === true;
    if (cancelled) this.cancelledJobs.add(job);
    const { current } = this.settleIdleStop(job, cancelled, stale);
    if (cancelled)
      return `${named} was stopped before wrapper registration. Its command will not run.`;
    return current ? `${named} is not running: nothing to stop.` : supersededReply(named);
  }

  register(pi: ExtensionAPI): void {
    registerJobTools(pi, this);
  }
}
