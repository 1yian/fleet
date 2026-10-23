import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Link } from "./link.ts";

const FALLBACK = "the model turn failed with no error message";

export class Failures {
  private failed: string | undefined;
  private unsent: string | undefined;
  private reported = false;
  private readonly link: Link;

  constructor(link: Link) {
    this.link = link;
  }

  get lastFailed(): boolean {
    return this.failed !== undefined;
  }

  flush(): void {
    const error = this.unsent;
    if (error === undefined) return;
    this.unsent = undefined;
    this.send(error);
  }

  register(pi: ExtensionAPI): void {
    pi.on("message_end", (event) => {
      const { message } = event;
      if (message.role !== "assistant") return;
      this.failed = message.stopReason === "error" ? (message.errorMessage ?? FALLBACK) : undefined;
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
