import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Link } from "./link.ts";

const FALLBACK_COMPACTION = "the conversation compaction failed with no error message";
const FALLBACK = "the model turn failed with no error message";

export class Failures {
  private failed: string | undefined;
  private unsent: string | undefined;
  private reported = false;
  private compactionReported = false;
  private compactionUnsent: string | undefined;
  private readonly link: Link;

  constructor(link: Link) {
    this.link = link;
  }

  get lastFailed(): boolean {
    return this.failed !== undefined;
  }

  expectCompaction(): void {
    this.compactionReported = true;
  }

  flush(): void {
    const error = this.unsent;
    const compaction = this.compactionUnsent;
    this.unsent = undefined;
    this.compactionUnsent = undefined;
    if (error !== undefined) this.send(error);
    if (compaction !== undefined) this.sendCompaction(compaction);
  }

  register(pi: ExtensionAPI): void {
    pi.on("message_end", (event) => {
      const { message } = event;
      if (message.role !== "assistant") return;
      this.failed = message.stopReason === "error" ? (message.errorMessage ?? FALLBACK) : undefined;
    });
    pi.on("session_compact_failed", (event) => {
      if (!event.aborted) this.sendCompaction(event.errorMessage ?? FALLBACK_COMPACTION);
    });
    pi.on("session_compact", () => {
      if (!this.compactionReported) return;
      this.compactionReported = false;
      this.link.call("incident.clear", { compacted: true }).catch(() => undefined);
    });
    pi.on("agent_settled", (event) => {
      if (event.aborted) return;
      if (this.failed !== undefined) this.send(this.failed);
      else if (this.reported) {
        this.reported = false;
        this.link.call("incident.clear", {}).catch(() => undefined);
      }
    });
  }

  private sendCompaction(error: string): void {
    this.link.call("incident.report", { error, phase: "compaction" }).then(
      () => {
        this.compactionReported = true;
      },
      () => {
        this.compactionUnsent = error;
      },
    );
  }

  private send(error: string): void {
    this.link.call("incident.report", { error }).then(
      () => {
        this.reported = true;
      },
      () => {
        this.unsent = error;
      },
    );
  }
}
