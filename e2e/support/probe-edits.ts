import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { optionalString, type JsonRecord } from "./json.ts";

export function probeEdits(
  pi: ExtensionAPI,
  report: (event: Record<string, unknown>) => void,
): ((command: JsonRecord) => void) & { started: (ctx: ExtensionContext) => void } {
  let context: ExtensionContext | undefined;
  let systemSuffix = "";
  const addTool = (name: string): void => {
    pi.registerTool({
      name,
      label: name,
      description: `Extra tool ${name}.`,
      parameters: Type.Object({}),
      execute: () => Promise.resolve({ content: [{ type: "text", text: name }], details: {} }),
    });
  };
  const switchModel = async (id: string): Promise<void> => {
    const model = context?.modelRegistry.find("tier", id);
    if (model !== undefined) await pi.setModel(model);
    report({ type: "model_set", id });
  };
  pi.on("before_agent_start", (event) =>
    systemSuffix === "" ? undefined : { systemPrompt: `${event.systemPrompt}\n${systemSuffix}` },
  );
  const apply = (command: JsonRecord): void => {
    if (command["type"] === "add_tool") addTool(optionalString(command, "name") ?? "extra");
    if (command["type"] === "system") systemSuffix = optionalString(command, "text") ?? "";
    if (command["type"] === "model") void switchModel(optionalString(command, "id") ?? "");
  };
  return Object.assign(apply, {
    started: (ctx: ExtensionContext): void => {
      context = ctx;
    },
  });
}
