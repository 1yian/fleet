import { spawnSync } from "node:child_process";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function shellTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "bash",
    label: "Bash",
    description: "Runs a shell command.",
    parameters: Type.Object({ command: Type.String() }),
    execute: (_id, params) => {
      const run = spawnSync("/bin/sh", ["-c", params.command], { encoding: "utf8" });
      const text = `${run.stdout}${run.stderr}exit ${String(run.status ?? 1)}`;
      return Promise.resolve({ content: [{ type: "text", text }], details: {} });
    },
  });
}
