import type { Cdp } from "@fleet/protocol";
import { ADOPT_ROOT } from "./script.ts";
import { record, words } from "./wire.ts";

const CHILD_LISTS = ["children", "shadowRoots"];

function closedRoots(node: unknown, found: number[] = []): number[] {
  const fields = record(node);
  if (fields === undefined) return found;
  const id = fields["backendNodeId"];
  if (words(fields, "shadowRootType") === "closed" && typeof id === "number") found.push(id);
  for (const key of CHILD_LISTS) {
    const list = fields[key];
    if (Array.isArray(list)) for (const child of list) closedRoots(child, found);
  }
  closedRoots(fields["contentDocument"], found);
  return found;
}

export async function adoptClosedRoots(cdp: Cdp, sessionId: string): Promise<void> {
  const on = { sessionId };
  try {
    await cdp.send("DOM.enable", {}, on);
    const tree = record(await cdp.send("DOM.getDocument", { depth: -1, pierce: true }, on));
    for (const backendNodeId of closedRoots(tree?.["root"])) {
      const resolved = record(await cdp.send("DOM.resolveNode", { backendNodeId }, on));
      const objectId = words(record(resolved?.["object"]), "objectId");
      if (objectId === undefined) continue;
      await cdp.send("Runtime.callFunctionOn", { objectId, functionDeclaration: ADOPT_ROOT }, on);
    }
  } catch (error) {
    console.error(`guard: cannot look for closed shadow roots: ${String(error)}`);
  }
  await cdp.send("DOM.disable", {}, on).catch(() => undefined);
}
