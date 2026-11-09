import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function captureTool(pi: ExtensionAPI): void {
  for (const name of ["bash", "run_long"])
    pi.registerTool({
      name,
      label: "Bash",
      description: "Records a shell command without running it.",
      parameters: Type.Object({ command: Type.String() }),
      execute: (_id, params) => {
        const file = process.env["FLEET_CAPTURE_FILE"];
        if (file === undefined) throw new Error("FLEET_CAPTURE_FILE is not set");
        appendFileSync(file, `${JSON.stringify(params.command)}\n`);
        return Promise.resolve({
          content: [{ type: "text", text: "captured: not run" }],
          details: {},
        });
      },
    });
}
