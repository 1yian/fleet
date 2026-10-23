import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const LABELS: Readonly<Record<string, string>> = {
  "stale-module": "stale Pi module",
  "router-cooldown": "model cooldown",
  "vendor-quota": "model quota",
  auth: "model auth",
  transient: "model unavailable",
};

export const failureLabel = (classification: string | undefined, compaction: boolean): string =>
  `failed: ${(classification === undefined ? undefined : LABELS[classification]) ?? (compaction ? "compaction" : "turn error")}`;

export class Blockage {
  private readonly pi: ExtensionAPI;
  private raised = false;
  private epoch = 0;

  constructor(pi: ExtensionAPI) {
    this.pi = pi;
  }

  get now(): number {
    return this.epoch;
  }

  raise(label: string, since: number): void {
    if (this.raised || since !== this.epoch) return;
    this.raised = true;
    this.pi.events.emit("herdr:blocked", { active: true, label });
  }

  release(): void {
    this.epoch += 1;
    if (!this.raised) return;
    this.raised = false;
    setTimeout(() => {
      this.pi.events.emit("herdr:blocked", { active: false });
    }, 0);
  }
}
