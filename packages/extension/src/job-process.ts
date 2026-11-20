import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const NO_PROCESS_MATCHED = 1;

const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const jobFilePrefix = (job: number): string => join(tmpdir(), `fleet-job-${String(job)}-`);

export function jobProcessGone(job: number, within: number): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("pgrep", ["-f", "--", escaped(jobFilePrefix(job))], { timeout: within }, (error) => {
      resolve(error?.code === NO_PROCESS_MATCHED && typeof error.signal !== "string");
    });
  });
}
