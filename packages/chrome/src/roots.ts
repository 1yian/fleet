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

export class Scanner {
  private readonly tails = new Map<string, Promise<void>>();

  scan(cdp: Cdp, session: string): Promise<void> {
    const run = (this.tails.get(session) ?? Promise.resolve()).then(() =>
      this.inspect(cdp, session),
    );
    const done = run.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(session, done);
    void done.then(() => {
      if (this.tails.get(session) === done) this.tails.delete(session);
    });
    return run;
  }

  async parsed(cdp: Cdp, session: string, contexts: readonly number[]): Promise<boolean> {
    if (contexts.length === 0) return false;
    for (const contextId of contexts) {
      const state = await cdp
        .send(
          "Runtime.evaluate",
          { expression: "document.readyState", contextId, returnByValue: true },
          { sessionId: session },
        )
        .catch(() => undefined);
      const value = record(record(state)?.["result"])?.["value"];
      if (typeof value !== "string" || value === "loading") return false;
    }
    return true;
  }

  forget(session: string): void {
    this.tails.delete(session);
  }

  clear(): void {
    this.tails.clear();
  }

  private async inspect(cdp: Cdp, session: string): Promise<void> {
    const on = { sessionId: session };
    await cdp.send("DOM.enable", {}, on);
    try {
      const root = record(await cdp.send("DOM.getDocument", { depth: -1, pierce: true }, on))?.[
        "root"
      ];
      if (record(root) === undefined) throw new Error("the page gave no document");
      for (const backendNodeId of closedRoots(root)) {
        const resolved = record(await cdp.send("DOM.resolveNode", { backendNodeId }, on));
        const objectId = words(record(resolved?.["object"]), "objectId");
        if (objectId === undefined) throw new Error("a closed shadow root cannot be reached");
        const called = record(
          await cdp.send(
            "Runtime.callFunctionOn",
            { objectId, functionDeclaration: ADOPT_ROOT },
            on,
          ),
        );
        if (called?.["exceptionDetails"] !== undefined)
          throw new Error("a closed shadow root was not handed to the page script");
      }
    } finally {
      await cdp.send("DOM.disable", {}, on).catch(() => undefined);
    }
  }
}
