// Worker sessions: the report tool and the run-end check (spec sections 11.1
// and 12.3). A run may end only with a handoff, a tracked wait, or a queued
// continuation. Otherwise the worker gets one nudge, and then files `stopped`.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CardSchema, check } from "@fleet/protocol";
import Type from "typebox";
import { parseUtc, textOf } from "./inbox.ts";
import type { Jobs } from "./jobs.ts";
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
  pr: Type.Optional(
    Type.String({ pattern: "^https://", description: "The PR URL, with done on a ship card" }),
  ),
});

function untilMs(status: string, until: string | undefined): number | undefined {
  if (until !== undefined) return parseUtc(until);
  return status === "paused" ? Date.now() + PAUSE_DEFAULT_MS : undefined;
}

interface LatestReport {
  readonly status: string;
  readonly until: number | undefined;
}

export class WorkerRun {
  private latest: LatestReport | undefined;
  private unsent: string | undefined;
  private nudged = false;
  private lastText = "";
  private readonly link: Link;
  private readonly jobs: Jobs;

  constructor(link: Link, jobs: Jobs) {
    this.link = link;
    this.jobs = jobs;
  }

  /** New captain input or a new fleet entry starts a new obligation. */
  reset(): void {
    this.latest = undefined;
    this.unsent = undefined;
    this.nudged = false;
  }

  /** Files the stopped report that could not reach cardd. Called at each welcome. */
  flush(): void {
    const text = this.unsent;
    if (text === undefined) return;
    this.unsent = undefined;
    void this.fileStopped(text);
  }

  register(pi: ExtensionAPI): void {
    pi.registerTool({
      name: "report",
      label: "Report",
      description: "Records a report on your card. End every run with a handoff or a tracked wait.",
      parameters: ReportParams,
      execute: async (_id, params) => {
        const until = untilMs(params.status, params.until);
        const args = {
          status: params.status,
          text: params.text,
          key: params.key,
          until,
          pr: params.pr,
        };
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
      await this.fileStopped(text.slice(0, 2000));
    });
  }

  private async fileStopped(text: string): Promise<void> {
    await this.link.call("report", { status: "stopped", text }).catch(() => {
      if (this.latest?.status === "stopped") this.unsent = text;
    });
  }

  private mayEnd(): boolean {
    if (this.jobs.waiting) return true;
    if (this.latest === undefined) return false;
    const { status, until } = this.latest;
    if (status === "paused") return until !== undefined && until > Date.now();
    return HANDOFFS.has(status) || status === "stopped";
  }
}
