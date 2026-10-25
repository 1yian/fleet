import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function codemodeLimit(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "codemode_limit",
    label: "Codemode limit",
    description: "Reports the codemode worker limit of this process.",
    promptSnippet: "Codemode limit",
    parameters: Type.Object({}),
    execute: () =>
      Promise.resolve({
        content: [
          { type: "text", text: `limit=${process.env["PI_CODEMODE_MAX_WORKERS"] ?? "unset"}` },
        ],
        details: {},
      }),
  });
}
