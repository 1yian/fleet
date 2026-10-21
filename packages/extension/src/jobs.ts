import { randomBytes } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import Type from "typebox";
import { herdr, quote, rootPane } from "./host.ts";
import type { Link } from "./link.ts";

const WRAPPER = fileURLToPath(new URL("./job.ts", import.meta.url));
const DEFAULT_TIMEOUT_MINUTES = 60;
export const REVIEW_LABEL = "review";

const RunLongParams = Type.Object({
  label: Type.String({ pattern: "^[A-Za-z0-9._-]+$", description: "A short name, such as tests" }),
  command: Type.String({ minLength: 1, description: "The shell command to run" }),
  timeout_minutes: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 24 * 60 })),
});

interface JobOptions {
  readonly timeoutMs: number;
  readonly tailLines?: number;
  readonly lineChars?: number;
  readonly review?: string;
}

const POLL = /\blavish-axi['"]?\s+poll\b/;
const POLL_OF_PAGE =
  /^\s*lavish-axi\s+poll\s+('[^']*'|"[^"`$\\]*"|[^\s'"`$;&|<>()\\]+)(?:\s+--owner\s+(?:'[^']*'|"[^"`$\\]*"|[^\s'"`$;&|<>()\\]+))?\s*$/;

function polledPage(command: string): string | undefined {
  const quoted = POLL_OF_PAGE.exec(command)?.[1];
  return quoted?.replace(/^(['"])(.*)\1$/, "$2");
}

export class Jobs {
  private waitOnPage: ((page: string) => Promise<string>) | undefined;
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

  get reviewing(): boolean {
    return [...this.running.values()].includes(REVIEW_LABEL);
  }

  waitOnPolledPages(wait: (page: string) => Promise<string>): void {
    this.waitOnPage = wait;
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
  ): Promise<{ job: number; key: string | null; tab: string }> {
    const workspace = process.env["HERDR_WORKSPACE_ID"];
    if (workspace === undefined) throw new Error(`${label} needs a worker inside a herdr pane`);
    const { review } = options;
    const { job, heartbeatMs, key } = await this.link.call("job.start", {
      label,
      command,
      ...(review === undefined ? {} : { review }),
    });
    this.running.set(job, label);
    const file = join(tmpdir(), `fleet-job-${String(job)}-${randomBytes(4).toString("hex")}.json`);
    const tab = `job-${String(job)}-${label}`;
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
        review: review !== undefined,
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
    return { job, key, tab };
  }

  register(pi: ExtensionAPI): void {
    pi.registerTool({
      name: "run_long",
      label: "Run long",
      description:
        "Runs a long command in its own herdr tab and returns at once. The result arrives later as a [fleet] message. You may end your run while it runs. It stops the command after timeout_minutes (default 60), so never wrap the command in timeout or gtimeout.",
      parameters: RunLongParams,
      execute: async (_id, params) => {
        const { label, command } = params;
        if (label === REVIEW_LABEL) throw new Error("wait on a review page with wait_review");
        if (POLL.test(command)) {
          const page = polledPage(command);
          if (page === undefined || this.waitOnPage === undefined)
            throw new Error("wait on a review page with wait_review, not a lavish-axi poll job");
          return {
            content: [{ type: "text", text: await this.waitOnPage(page) }],
            details: {},
          };
        }
        const timeoutMs = (params.timeout_minutes ?? DEFAULT_TIMEOUT_MINUTES) * 60_000;
        const { job, tab } = await this.launch(label, command, { timeoutMs });
        const text = `Started job ${String(job)} (${label}) in tab ${tab}. Its result arrives as a [fleet] message; you may end this run.`;
        return { content: [{ type: "text", text }], details: {} };
      },
    });
  }
}
