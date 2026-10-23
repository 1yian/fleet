import { AgentSession, SettingsManager } from "@earendil-works/pi-coding-agent";
import { isRecord } from "./lane-config.ts";
import { methodOf, once } from "./patch.ts";

const WORKER_CONTEXT_CAP = 500_000;
const COMPACTION_SHARE = 0.8;

let windowInForce: number | undefined;

function windowOf(model: unknown): number {
  const window = isRecord(model) ? model["contextWindow"] : undefined;
  return typeof window === "number" && window > 0 ? window : 0;
}

function effectiveWindow(window: number): number {
  return Math.min(window, WORKER_CONTEXT_CAP);
}

function capped(model: unknown): unknown {
  const window = windowOf(model);
  return isRecord(model) && window > WORKER_CONTEXT_CAP
    ? { ...model, contextWindow: WORKER_CONTEXT_CAP }
    : model;
}

function whileWindowIs<T>(model: unknown, run: () => T): T {
  const before = windowInForce;
  windowInForce = windowOf(model);
  try {
    return run();
  } finally {
    windowInForce = before;
  }
}

function installWorkerLimit(): void {
  const settings = SettingsManager.prototype;
  const session = AgentSession.prototype;
  const compaction = methodOf(settings, "getCompactionSettings");
  const exceeds = methodOf(session, "_exceedsCompactionThreshold");
  const check = methodOf(session, "_checkCompaction");
  const responder = methodOf(session, "_modelForMessage");

  Reflect.set(settings, "getCompactionSettings", function (this: object, model: unknown) {
    const found = compaction(this, model);
    const window = effectiveWindow(windowInForce ?? windowOf(model));
    if (!isRecord(found) || window <= 0) return found;
    return { ...found, reserveTokens: Math.round(window * (1 - COMPACTION_SHARE)) };
  });
  Reflect.set(
    session,
    "_exceedsCompactionThreshold",
    function (this: object, model: unknown, projection: unknown) {
      return whileWindowIs(model, () => exceeds(this, capped(model), projection));
    },
  );
  Reflect.set(session, "_modelForMessage", function (this: object, message: unknown) {
    return capped(responder(this, message));
  });
  Reflect.set(session, "_checkCompaction", function (this: object, ...args: unknown[]) {
    const answered = responder(this, args[0]);
    const selected: unknown = Reflect.get(this, "model");
    const model = answered ?? selected;
    return whileWindowIs(model, () => check(this, ...args));
  });
}

export function applyContextPolicy(role: "mate" | "worker"): void {
  if (role !== "worker") return;
  once("worker-context-limit", () => {
    try {
      installWorkerLimit();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(`Fleet context limit: unavailable, the worker keeps Pi's own limit. ${reason}`);
    }
  });
}
