import { randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { check, OPS } from "@fleet/protocol";
import { quote } from "@fleet/protocol/route";
import Type from "typebox";
import { joinContained } from "./containment.ts";
import { field, herdr, records, rootPane } from "./host.ts";
import { jobHandshake } from "./job-http.ts";
import type { Link } from "./link.ts";
import { forwardedEnvironment } from "./scratch.ts";

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
  tab?: string;
  dispatched: boolean;
  fenced: boolean;
}

interface Preparing {
  fence?: { job: number; detail: string };
}

export class Jobs {
  private readonly preparing = new Map<string, Preparing>();
  private readonly running = new Set<number>();
  private readonly pending = new Map<number, PendingDispatch>();
  private readonly link: Link;
  private readonly cardd: { url: string; token: string };
  private readonly warn: (text: string) => void;

  constructor(link: Link, cardd: { url: string; token: string }, warn: (text: string) => void) {
    this.link = link;
    this.cardd = cardd;
    this.warn = warn;
  }

  get waiting(): boolean {
    return this.running.size > 0 || [...this.pending.values()].some(({ dispatched }) => dispatched);
  }

  async sync(observed?: number): Promise<void> {
    const jobs = await this.link.call("jobs", {});
    this.running.clear();
    for (const { id } of jobs) {
      this.running.add(id);
      this.clearPending(id);
    }
    if (observed !== undefined) this.clearPending(observed);
  }

  confirmStartupFence(job: number, launch?: string, detail = "startup was fenced"): void {
    if (launch !== undefined) {
      const preparing = this.preparing.get(launch);
      if (preparing !== undefined) preparing.fence = { job, detail };
    }
    const pending = this.pending.get(job);
    if (pending === undefined || (launch !== undefined && pending.launch !== launch)) return;
    this.running.delete(job);
    pending.fenced = true;
    this.clearPending(job);
    if (pending.tab !== undefined) void this.closeStartupTab(job, pending.tab);
  }

  private clearPending(job: number): void {
    const pending = this.pending.get(job);
    if (pending === undefined) return;
    this.pending.delete(job);
    void rm(pending.file, { force: true }).catch(() => undefined);
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
    url: string,
    id: string,
    label: string,
    command: string,
  ): Promise<{ job: number; heartbeatMs: number; registeredLaunch: boolean }> {
    const endpoint = { url, token: this.cardd.token };
    const args = { launch: id, label, command };
    for (let attempt = 0; attempt < PREPARE_ATTEMPTS; attempt += 1) {
      const receipt = await jobHandshake(endpoint, "job.prepare", args)
        .then((reply) =>
          reply.ok ? { ...reply, value: check(OPS["job.prepare"].result, reply.value) } : reply,
        )
        .catch(() => undefined);
      if (receipt === undefined || (!receipt.ok && receipt.status >= 500)) continue;
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
  ): Promise<{ job: number; tab: string }> {
    const workspace = process.env["HERDR_WORKSPACE_ID"];
    if (workspace === undefined) throw new Error(`${label} needs a worker inside a herdr pane`);
    const url = this.cardd.url.replace(/^ws/, "http").replace(/\/session$/, "/call");
    const id = randomUUID();
    const preparing: Preparing = {};
    this.preparing.set(id, preparing);
    const { job, heartbeatMs, registeredLaunch } = await this.prepare(
      url,
      id,
      label,
      command,
    ).catch((error: unknown) => {
      this.preparing.delete(id);
      throw error;
    });
    this.preparing.delete(id);
    if (registeredLaunch && preparing.fence?.job === job)
      throw new Error(`Job ${String(job)} cannot start: ${preparing.fence.detail}`);
    const file = join(tmpdir(), `fleet-job-${String(job)}-${id}.json`);
    const tab = tabName(job, label);
    const pending: PendingDispatch | undefined = registeredLaunch
      ? { launch: id, file, dispatched: false, fenced: false }
      : undefined;
    try {
      const { timeoutMs, tailLines, lineChars } = options;
      const body = {
        url,
        token: this.cardd.token,
        job,
        ...(registeredLaunch ? { launch: { id, command } } : { command }),
        timeoutMs,
        heartbeatMs,
        tailLines,
        lineChars,
      };
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
      if (pending !== undefined) {
        const tabId = field(records([created["tab"]])[0], "tab_id");
        if (tabId === undefined) throw new Error("herdr did not return the job tab ID");
        if (pending.fenced) {
          void this.closeStartupTab(job, tabId);
          throw new Error(`Job ${String(job)} was fenced before dispatch`);
        }
        pending.tab = tabId;
      }
      const pane = rootPane(created);
      await joinContained("local", pane, process.cwd());
      if (pending?.fenced === true)
        throw new Error(`Job ${String(job)} was fenced before dispatch`);
      if (pending !== undefined) pending.dispatched = true;
      else this.running.add(job);
      await herdr("local", ["pane", "run", pane, `node ${quote(WRAPPER)} ${quote(file)}`]);
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      if (pending?.fenced === true) throw error;
      if (pending?.dispatched === true)
        throw new Error(
          `Could not confirm dispatch for job ${String(job)}; startup is still being checked: ${why}`,
          { cause: error },
        );
      rmSync(file, { force: true });
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
      if (pending !== undefined && finished?.recorded === true) this.confirmStartupFence(job);
      throw error;
    }
    return { job, tab };
  }

  async stop(job: number): Promise<string> {
    const workspace = process.env["HERDR_WORKSPACE_ID"];
    if (workspace === undefined) throw new Error("stop_job needs a worker inside a herdr pane");
    const { label, running, cancelled } = await this.link.call("job.stop", { job });
    const named = `job ${String(job)} (${label})`;
    if (!running) {
      this.running.delete(job);
      if (cancelled === true) this.confirmStartupFence(job);
      return cancelled === true
        ? `${named} was stopped before wrapper registration. Its command will not run.`
        : `${named} is not running: nothing to stop.`;
    }
    const tabs = records((await herdr("local", ["tab", "list", "--workspace", workspace]))["tabs"]);
    const tab = field(
      tabs.find((each) => each["label"] === tabName(job, label)),
      "tab_id",
    );
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
        const { job, tab } = await this.launch(label, command, { timeoutMs });
        const text = `Started job ${String(job)} (${label}) in tab ${tab}. Its result arrives as a [fleet] message; you may end this run.`;
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
