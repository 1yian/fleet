import { randomBytes } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import Type from "typebox";
import { field, herdr, quote, records, rootPane } from "./host.ts";
import type { Link } from "./link.ts";

const WRAPPER = fileURLToPath(new URL("./job.ts", import.meta.url));
const DEFAULT_TIMEOUT_MINUTES = 60;

const RunLongParams = Type.Object({
  label: Type.String({ pattern: "^[A-Za-z0-9._-]+$", description: "A short name, such as tests" }),
  command: Type.String({ minLength: 1, description: "The shell command to run" }),
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

export class Jobs {
  private readonly running = new Map<number, string>();
  private readonly link: Link;
  private readonly cardd: { url: string; token: string };

  constructor(link: Link, cardd: { url: string; token: string }) {
    this.link = link;
    this.cardd = cardd;
  }

  get waiting(): boolean {
    return this.running.size > 0;
  }

  finished(job: unknown): void {
    if (typeof job === "number") this.running.delete(job);
  }

  async sync(): Promise<void> {
    const jobs = await this.link.call("jobs", {});
    this.running.clear();
    for (const { id, label } of jobs) this.running.set(id, label);
  }

  async launch(
    label: string,
    command: string,
    options: JobOptions,
  ): Promise<{ job: number; tab: string }> {
    const workspace = process.env["HERDR_WORKSPACE_ID"];
    if (workspace === undefined) throw new Error(`${label} needs a worker inside a herdr pane`);
    const { job, heartbeatMs } = await this.link.call("job.start", {
      label,
      command,
    });
    this.running.set(job, label);
    const file = join(tmpdir(), `fleet-job-${String(job)}-${randomBytes(4).toString("hex")}.json`);
    const tab = tabName(job, label);
    try {
      const url = this.cardd.url.replace(/^ws/, "http").replace(/\/session$/, "/call");
      const { timeoutMs, tailLines, lineChars } = options;
      const body = {
        url,
        token: this.cardd.token,
        job,
        command,
        timeoutMs,
        heartbeatMs,
        tailLines,
        lineChars,
      };
      writeFileSync(file, JSON.stringify(body), { mode: 0o600 });
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
      ]);
      await herdr("local", [
        "pane",
        "run",
        rootPane(created),
        `node ${quote(WRAPPER)} ${quote(file)}`,
      ]);
    } catch (error) {
      rmSync(file, { force: true });
      this.running.delete(job);
      const outputTail = `could not start: ${error instanceof Error ? error.message : String(error)}`;
      await this.link.call("job.finish", { job, exitCode: 127, outputTail }).catch(() => 0);
      throw error;
    }
    return { job, tab };
  }

  async stop(job: number): Promise<string> {
    const workspace = process.env["HERDR_WORKSPACE_ID"];
    if (workspace === undefined) throw new Error("stop_job needs a worker inside a herdr pane");
    const { label, running } = await this.link.call("job.stop", { job });
    const named = `job ${String(job)} (${label})`;
    if (!running)
      return `${named} is not running: nothing to stop. Its result is already recorded.`;
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
