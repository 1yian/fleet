import { isRecord, optionalString, type JsonRecord } from "./json.ts";

interface Held {
  readonly session: string;
  readonly group: string;
}

export class HeldObjects {
  private readonly asked = new Map<number, Held>();
  private readonly held = new Map<string, Held>();

  get count(): number {
    return this.held.size;
  }

  sent(message: JsonRecord): void {
    const method = optionalString(message, "method");
    const params = isRecord(message["params"]) ? message["params"] : {};
    const entry = {
      session: optionalString(message, "sessionId") ?? "",
      group: optionalString(params, "objectGroup") ?? "",
    };
    const id = message["id"];
    if (method === "DOM.resolveNode" && typeof id === "number") this.asked.set(id, entry);
    if (method === "Runtime.releaseObject")
      this.held.delete(`${entry.session}|${optionalString(params, "objectId") ?? ""}`);
    if (method === "Runtime.releaseObjectGroup") this.releaseGroup(entry);
  }

  answered(message: JsonRecord): void {
    const id = message["id"];
    const ask = typeof id === "number" ? this.asked.get(id) : undefined;
    if (ask === undefined || typeof id !== "number") return;
    this.asked.delete(id);
    const result = message["result"];
    const object = isRecord(result) ? result["object"] : undefined;
    const objectId = isRecord(object) ? optionalString(object, "objectId") : undefined;
    if (objectId !== undefined) this.held.set(`${ask.session}|${objectId}`, ask);
  }

  private releaseGroup(group: Held): void {
    for (const [key, entry] of this.held)
      if (entry.session === group.session && entry.group === group.group) this.held.delete(key);
  }
}
