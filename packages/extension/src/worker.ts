// Worker sessions: the report tool and the run-end check (spec sections 11.1
// and 12.3). A run may end only with a handoff, a tracked wait, or a queued
// continuation. Otherwise the worker gets one nudge, and then files `stopped`.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CardSchema, check } from "@fleet/protocol";
import Type from "typebox";
import type { Link } from "./link.ts";

const HANDOFFS: ReadonlySet<string> = new Set(["done", "failed", "blocked", "needs-decision"]);
const PAUSE_DEFAULT_MS = 2 * 60 * 60 * 1000;
const NUDGE =
  "[fleet] Your run is ending without a handoff. Report done, failed, blocked, or " +
  "needs-decision, or report paused with an until date. Otherwise your card goes back to your mate as stopped.";

const ReportParams = Type.Object({
  status: Type.Enum(
    [
      "working",
      "note",
      "paused",
      "blocked",
      "needs-decision",
      "resolved",
      "in-review",
      "done",
      "failed",
    ],
    { description: "done, failed, blocked, and needs-decision hand the card off" },
  ),
  text: Type.String({ minLength: 1, description: "What happened, in one or two sentences" }),
  key: Type.Optional(Type.String({ pattern: "^[A-Za-z0-9._-]+$", description: "Decision key" })),
  until: Type.Optional(
    Type.String({ description: "ISO 8601 UTC time like 2026-05-01T10:00:00Z, for paused" }),
  ),
});

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

function untilMs(status: string, until: string | undefined): number | undefined {
  if (until !== undefined) {
    const ms = ISO_UTC.test(until) ? Date.parse(until) : Number.NaN;
    if (Number.isNaN(ms))
      throw new Error(
        `until must be an ISO 8601 time ending in Z or a +hh:mm/-hh:mm offset, like 2026-05-01T10:00:00Z: ${until}`,
      );
    return ms;
  }
  return status === "paused" ? Date.now() + PAUSE_DEFAULT_MS : undefined;
}

function textOf(message: unknown): string {
  if (typeof message !== "object" || message === null || !("content" in message)) return "";
  const content: unknown = message.content;
  if (!Array.isArray(content)) return typeof content === "string" ? content : "";
  return content
    .map((block: unknown) =>
      typeof block === "object" &&
      block !== null &&
      "text" in block &&
      typeof block.text === "string"
        ? block.text
        : "",
    )
    .join("");
}

interface LatestReport {
  readonly status: string;
  readonly until: number | undefined;
}

export class WorkerRun {
  private latest: LatestReport | undefined;
  private nudged = false;
  private lastText = "";
  private readonly link: Link;

  constructor(link: Link) {
    this.link = link;
  }

  /** New captain input or a new fleet entry starts a new obligation. */
  reset(): void {
    this.latest = undefined;
    this.nudged = false;
  }

  register(pi: ExtensionAPI): void {
    pi.registerTool({
      name: "report",
      label: "Report",
      description: "Records a report on your card. End every run with a handoff or a tracked wait.",
      parameters: ReportParams,
      execute: async (_id, params) => {
        const until = untilMs(params.status, params.until);
        const args = { status: params.status, text: params.text, key: params.key, until };
        const card = check(CardSchema, await this.link.call("report", args));
        this.latest = { status: params.status, until };
        const text = `Reported ${params.status}. c-${String(card.id)} is now ${card.status}.`;
        return { content: [{ type: "text", text }], details: {} };
      },
    });
    pi.on("input", () => {
      this.reset();
    });
    pi.on("message_end", (event) => {
      if (event.message.role === "assistant") this.lastText = textOf(event.message);
    });
    pi.on("agent_before_settle", (event) => {
      if (this.mayEnd() || event.context.pendingMessages.length > 0 || this.nudged)
        return undefined;
      this.nudged = true;
      const nudge = {
        type: "custom_message",
        customType: "fleet-nudge",
        content: NUDGE,
        display: true,
      } as const;
      return { continue: true, entries: [nudge] };
    });
    pi.on("agent_settled", async (event) => {
      if (!event.aborted && this.mayEnd()) return;
      const text = event.aborted
        ? "stopped from the pane"
        : `ended the run without a handoff: ${this.lastText}`;
      this.latest = { status: "stopped", until: undefined };
      await this.link
        .call("report", { status: "stopped", text: text.slice(0, 2000) })
        .catch(() => undefined);
    });
  }

  private mayEnd(): boolean {
    if (this.latest === undefined) return false;
    const { status, until } = this.latest;
    if (status === "paused") return until !== undefined && until > Date.now();
    return HANDOFFS.has(status) || status === "stopped";
  }
}
