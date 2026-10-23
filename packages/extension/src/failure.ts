import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Blockage, failureLabel } from "./blockage.ts";
import { compactionFailed, compactionSucceeded } from "./compaction-backoff.ts";
import type { Link } from "./link.ts";
import { routerResumeAt } from "./router-cooldown.ts";

const FALLBACK_COMPACTION = "the conversation compaction failed with no error message";
const MODEL_FAULTS: ReadonlySet<string> = new Set([
  "router-cooldown",
  "vendor-quota",
  "auth",
  "transient",
]);
const FALLBACK = "the model turn failed with no error message";

export class Failures {
  private failed: string | undefined;
  private unsent: string | undefined;
  private reported = false;
  private compactionReported = false;
  private compactionUnsent: string | undefined;
  private compactionPending: string | undefined;
  private compactionLabel = failureLabel(undefined, true);
  private readonly link: Link;
  private blockage: Blockage | undefined;
  private owed: string | undefined;

  constructor(link: Link) {
    this.link = link;
  }

  get lastFailed(): boolean {
    return this.failed !== undefined;
  }

  obligation(label: string | undefined): void {
    this.owed = label;
    if (label === undefined) {
      if (this.failed === undefined) this.blockage?.release();
    } else if (this.blockage !== undefined) this.blockage.raise(label, this.blockage.now);
  }

  expectCompaction(): void {
    this.compactionReported = true;
  }

  flush(): void {
    const error = this.unsent;
    const compaction = this.compactionUnsent;
    this.unsent = undefined;
    this.compactionUnsent = undefined;
    if (error !== undefined) this.report(error, false, false);
    if (compaction !== undefined) this.report(compaction, true, false);
  }

  register(pi: ExtensionAPI): void {
    const blockage = new Blockage(pi);
    this.blockage = blockage;
    pi.on("agent_start", () => {
      if (this.owed === undefined) blockage.release();
    });
    pi.on("message_end", (event) => {
      const { message } = event;
      if (message.role !== "assistant") return;
      this.failed = message.stopReason === "error" ? (message.errorMessage ?? FALLBACK) : undefined;
    });
    pi.on("session_compact_failed", (event, ctx) => {
      if (event.aborted) return;
      const error = event.errorMessage ?? FALLBACK_COMPACTION;
      compactionFailed(error);
      const idle = ctx.isIdle();
      this.compactionPending = idle ? undefined : error;
      this.report(error, true, idle);
    });
    pi.on("session_compact", () => {
      compactionSucceeded();
      this.compactionPending = undefined;
      if (this.owed === undefined) blockage.release();
      if (!this.compactionReported) return;
      this.compactionReported = false;
      this.link.call("incident.clear", { compacted: true }).catch(() => undefined);
    });
    pi.on("agent_settled", (event) => {
      if (this.owed !== undefined) blockage.raise(this.owed, blockage.now);
      if (event.aborted) return;
      const pending = this.compactionPending;
      this.compactionPending = undefined;
      if (pending !== undefined && this.failed === undefined)
        blockage.raise(this.compactionLabel, blockage.now);
      if (this.failed !== undefined) this.report(this.failed, false, true);
      else if (this.reported) {
        this.reported = false;
        this.link.call("incident.clear", {}).catch(() => undefined);
      }
    });
  }

  private report(error: string, compaction: boolean, blocks: boolean): void {
    const blockage = this.blockage;
    const since = blockage?.now ?? 0;
    const phase = compaction ? ({ phase: "compaction" } as const) : {};
    const resumeAt = routerResumeAt(error);
    const resume = resumeAt === undefined ? {} : { resumeAt };
    this.link.call("incident.report", { error, ...phase, ...resume }).then(
      (result) => {
        if (compaction) this.compactionReported = true;
        else this.reported = true;
        const label = failureLabel(result.classification, compaction);
        if (compaction) this.compactionLabel = label;
        if (blocks && !MODEL_FAULTS.has(result.classification)) blockage?.raise(label, since);
      },
      () => {
        if (compaction) this.compactionUnsent = error;
        else this.unsent = error;
        if (blocks) blockage?.raise(failureLabel(undefined, compaction), since);
      },
    );
  }
}
