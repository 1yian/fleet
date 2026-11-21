import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import Type from "typebox";
import type { Link } from "./link.ts";

const DEFAULT_TIMEOUT_MINUTES = 60;

interface JobTools {
  launch(
    label: string,
    command: string,
    options: { readonly timeoutMs: number },
  ): Promise<{ job: number; tab: string; started: boolean }>;
  stop(job: number): Promise<string>;
}

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

export function registerJobTools(pi: ExtensionAPI, jobs: JobTools): void {
  pi.registerTool({
    name: "run_long",
    label: "Run long",
    description:
      "Runs a long command in its own herdr tab and returns at once. The result arrives later as a [fleet] message. You may end your run while it runs. It stops the command after timeout_minutes (default 60 minutes, maximum 120 minutes / 2 hours), so never wrap the command in timeout or gtimeout.",
    parameters: RunLongParams,
    execute: async (_id, params) => {
      const { label, command } = params;
      const timeoutMs = (params.timeout_minutes ?? DEFAULT_TIMEOUT_MINUTES) * 60_000;
      const { job, tab, started } = await jobs.launch(label, command, { timeoutMs });
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
      content: [{ type: "text", text: await jobs.stop(params.job) }],
      details: {},
    }),
  });
}
