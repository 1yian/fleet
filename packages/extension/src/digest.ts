import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CAPTAIN, type Entry } from "@fleet/protocol";
import type { Costs } from "./lane-config.ts";

const BATCHED_KINDS: ReadonlySet<string> = new Set([
  "report",
  "comment",
  "cleanup",
  "merge",
  "release",
  "note",
  "finding",
]);
const WAITING_STATUSES: ReadonlySet<string> = new Set([
  "question",
  "blocked",
  "needs-decision",
  "failed",
]);
const MINUTE = 60_000;

function isRoutine(entry: Entry, mode: "steer" | "followUp"): boolean {
  if (mode === "steer" || entry.author === CAPTAIN || !BATCHED_KINDS.has(entry.kind)) return false;
  if (entry.fields["owes"] !== undefined) return false;
  const status = entry.fields["status"];
  return !(typeof status === "string" && WAITING_STATUSES.has(status));
}

export class Digest {
  private held = 0;
  private running = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly windowMs: number;
  private readonly pi: ExtensionAPI;

  constructor(pi: ExtensionAPI, costs: Costs | undefined) {
    this.pi = pi;
    this.windowMs = (costs?.digestMinutes ?? 0) * MINUTE;
  }

  register(): void {
    this.pi.on("agent_start", () => {
      this.running = true;
      this.held = 0;
      this.clear();
    });
    this.pi.on("agent_settled", () => {
      this.running = false;
      if (this.held > 0) this.arm();
    });
  }

  holds(entry: Entry, mode: "steer" | "followUp"): boolean {
    if (this.windowMs <= 0 || !isRoutine(entry, mode)) return false;
    this.held += 1;
    if (!this.running) this.arm();
    return true;
  }

  private arm(): void {
    this.timer ??= setTimeout(() => {
      this.timer = undefined;
      this.fire();
    }, this.windowMs);
  }

  private clear(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private fire(): void {
    if (this.running || this.held === 0) return;
    const count = this.held;
    this.pi.sendMessage(
      {
        customType: "fleet-digest",
        content: `[fleet] digest: ${String(count)} routine ${count === 1 ? "update comes" : "updates come"} with this message, held up to ${String(this.windowMs / MINUTE)} minutes. Handle each as its own message asks, or yield when none needs anything.`,
        display: true,
      },
      { triggerTurn: true },
    );
  }
}
