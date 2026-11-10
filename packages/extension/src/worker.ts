import { OPS } from "@fleet/protocol";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import Type from "typebox";
import { parseUtc, textOf } from "./inbox.ts";
import type { Failures } from "./failure.ts";
import type { Jobs } from "./jobs.ts";
import type { Link } from "./link.ts";

const HANDOFFS: ReadonlySet<string> = new Set([
  "done",
  "merged",
  "failed",
  "blocked",
  "needs-decision",
]);
const BLOCKED_PANE = "blocked: reported";
const STANDING_MS = Number(process.env["FLEET_STANDING_MS"]) || 15_000;
const STANDING_DEADLINE_MS = 5_000;
const EXIT_SIGNALS = ["SIGTERM", "SIGHUP"] as const;
export const LEAVING = "fleet:leaving";
const NUDGE =
  "[fleet] Your run is ending without a handoff. Report done, failed, blocked, or " +
  "needs-decision, or report paused with an until date if you wait on a time or an outside event. " +
  "Otherwise your card goes back to your mate as stopped.";

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
      "merged",
      "failed",
    ],
    {
      description:
        "done, merged, failed, blocked, and needs-decision hand the card off. merged requires pr: its full URL",
    },
  ),
  text: Type.String({ minLength: 1, description: "What happened, in one or two sentences" }),
  key: Type.Optional(Type.String({ pattern: "^[A-Za-z0-9._-]+$", description: "Decision key" })),
  until: Type.Optional(
    Type.String({
      description:
        "ISO 8601 UTC time like 2026-05-01T10:00:00Z. Required for paused: when the wait on a time or an outside event ends",
    }),
  ),
  replyTo: OPS.report.args.properties.replyTo,
  pr: Type.Optional(
    Type.String({
      pattern: "^https://github\\.com/[^/\\s]+/[^/\\s]+/pull/[0-9]+$",
      description:
        "The full https URL of your PR. Pass it on your done report and on the merged report.",
    }),
  ),
  merged: Type.Optional(
    Type.Boolean({ description: "true on the done report you send after you merged your PR" }),
  ),
});

interface LatestReport {
  readonly status: string;
  readonly until: number | undefined;
}

function pauseHint(latest: LatestReport | undefined): boolean {
  return latest?.status === "paused" && latest.until !== undefined && latest.until > Date.now();
}

export class WorkerRun {
  private latest: LatestReport | undefined;
  private unsent: string | undefined;
  private nudged = false;
  private recoveryCheck = false;
  private leaving = false;
  private lastText = "";
  private paneEpoch = 0;
  private disposed = false;
  private recheck: ReturnType<typeof setTimeout> | undefined;
  private readonly link: Link;
  private readonly jobs: Jobs;
  private readonly failures: Failures;

  constructor(link: Link, jobs: Jobs, failures: Failures) {
    this.link = link;
    this.jobs = jobs;
    this.failures = failures;
  }

  reset(): void {
    this.latest = undefined;
    this.unsent = undefined;
    this.nudged = false;
    this.recoveryCheck = false;
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.recheck);
  }

  private async settlePane(fallback: boolean): Promise<void> {
    const epoch = ++this.paneEpoch;
    clearTimeout(this.recheck);
    const blocked = await this.link.call("standing", {}, STANDING_DEADLINE_MS).then(
      (shown) => shown.attention === "blocked",
      () => fallback,
    );
    if (this.disposed || epoch !== this.paneEpoch) return;
    this.failures.obligation(blocked ? BLOCKED_PANE : undefined);
    if (!blocked) return;
    this.recheck = setTimeout(() => {
      void this.settlePane(true);
    }, STANDING_MS);
    this.recheck.unref();
  }

  checkingHealth(): void {
    this.recoveryCheck = true;
  }

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
      description:
        "Records a report on your card. End every run with a handoff or a tracked wait. paused is only for a wait on a time or an outside event (a quota reset, a third party, a CI run, a date) and needs until, within 24 hours from now; longer waits need a dated hold from your mate. A wait on your mate's action is blocked, never paused.",
      parameters: ReportParams,
      execute: async (_id, params) => {
        const until = params.until === undefined ? undefined : parseUtc(params.until);
        const args = {
          status: params.status,
          text: params.text,
          key: params.key,
          until,
          replyTo: params.replyTo,
          pr: params.pr,
          merged: params.merged,
        };
        const card = await this.link.call("report", args);
        this.latest = { status: params.status, until };
        await this.settlePane(params.status === "blocked");
        const text = `Reported ${params.status}. c-${String(card.id)} is now ${card.status}.`;
        return { content: [{ type: "text", text }], details: {} };
      },
    });
    pi.on("input", () => {
      this.reset();
    });
    this.watchForExit(pi);
    pi.on("message_end", (event) => {
      if (event.message.role === "assistant") this.lastText = textOf(event.message);
    });
    pi.on("agent_before_settle", (event) => {
      if (
        this.failures.lastFailed ||
        this.mayEnd() ||
        event.context.pendingMessages.length > 0 ||
        this.nudged
      )
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
      if (event.aborted ? this.leaving : this.failures.lastFailed || this.mayEnd()) return;
      const text = event.aborted
        ? "stopped from the pane"
        : `ended the run without a handoff: ${this.lastText}`;
      this.latest = { status: "stopped", until: undefined };
      await this.fileStopped(text.slice(0, 2000));
    });
  }

  private watchForExit(pi: ExtensionAPI): void {
    const leave = (): void => {
      this.leaving = true;
    };
    for (const signal of EXIT_SIGNALS) process.on(signal, leave);
    const unsubscribe = pi.events.on(LEAVING, leave);
    pi.on("session_shutdown", () => {
      for (const signal of EXIT_SIGNALS) process.off(signal, leave);
      unsubscribe();
    });
  }

  private async fileStopped(text: string): Promise<void> {
    await this.link
      .call("report", { status: "stopped", text })
      .then(async () => {
        await this.settlePane(false);
        return this.jobs.sync();
      })
      .catch(() => {
        if (this.latest?.status === "stopped") this.unsent = text;
      });
  }

  private mayEnd(): boolean {
    if (this.jobs.waiting || this.recoveryCheck) return true;
    if (pauseHint(this.latest)) return true;
    const status = this.latest?.status;
    return status !== undefined && (HANDOFFS.has(status) || status === "stopped");
  }
}
