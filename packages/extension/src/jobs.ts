// run_long (spec section 11.1): one command in one named herdr tab that the
// captain can watch. cardd records the job first. The wrapper posts the result,
// which arrives as a fleet entry, also after a Pi restart. Nothing runs a job again.
import { randomBytes } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { check, OPS } from "@fleet/protocol";
import Type from "typebox";
import { herdr, quote, rootPane } from "./host.ts";
import type { Link } from "./link.ts";

const WRAPPER = fileURLToPath(new URL("./job.ts", import.meta.url));
const DEFAULT_TIMEOUT_MINUTES = 60;

const RunLongParams = Type.Object({
  label: Type.String({ pattern: "^[A-Za-z0-9._-]+$", description: "A short name, such as tests" }),
  command: Type.String({ minLength: 1, description: "The shell command to run" }),
  timeout_minutes: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 24 * 60 })),
});

/** Running jobs are a tracked wait: the worker may end its run while one runs. */
export class Jobs {
  private readonly running = new Set<number>();
  private readonly link: Link;

  constructor(link: Link) {
    this.link = link;
  }

  get waiting(): boolean {
    return this.running.size > 0;
  }

  finished(job: unknown): void {
    if (typeof job === "number") this.running.delete(job);
  }

  /** Restores the running jobs after a connect, for example after a Pi restart. */
  async sync(): Promise<void> {
    const jobs = check(OPS.jobs.result, await this.link.call("jobs", {}));
    this.running.clear();
    for (const { id } of jobs) this.running.add(id);
  }

  register(pi: ExtensionAPI, cardd: { url: string; token: string }): void {
    pi.registerTool({
      name: "run_long",
      label: "Run long",
      description:
        "Runs a long command in its own herdr tab and returns at once. The result arrives later as a [fleet] message. You may end your run while it runs.",
      parameters: RunLongParams,
      execute: async (_id, params) => {
        const workspace = process.env["HERDR_WORKSPACE_ID"];
        if (workspace === undefined) throw new Error("run_long needs a worker inside a herdr pane");
        const { label, command } = params;
        const { job, heartbeatMs } = check(
          OPS["job.start"].result,
          await this.link.call("job.start", { label, command }),
        );
        this.running.add(job);
        const file = join(
          tmpdir(),
          `fleet-job-${String(job)}-${randomBytes(4).toString("hex")}.json`,
        );
        const tab = `job-${String(job)}-${label}`;
        try {
          const url = cardd.url.replace(/^ws/, "http").replace(/\/session$/, "/call");
          const timeoutMs = (params.timeout_minutes ?? DEFAULT_TIMEOUT_MINUTES) * 60_000;
          const body = { url, token: cardd.token, job, command, timeoutMs, heartbeatMs };
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
        const text = `Started job ${String(job)} (${label}) in tab ${tab}. Its result arrives as a [fleet] message; you may end this run.`;
        return { content: [{ type: "text", text }], details: {} };
      },
    });
  }
}
