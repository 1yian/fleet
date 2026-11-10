import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Blockage, failureLabel } from "./blockage.ts";
import { compactionFailed, compactionSucceeded } from "./compaction-backoff.ts";
import type { Link } from "./link.ts";
import { routerResumeAt } from "./router-cooldown.ts";

const FALLBACK_COMPACTION = "the conversation compaction failed with no error message";
const PI_FAULT =
  /cannot find (module|package)|ERR_MODULE_NOT_FOUND|failed to load url|does not provide an export/i;
const FALLBACK = "the model turn failed with no error message";
const KEY = Symbol.for("fleet:untold-incidents");

interface Untold {
  clear: boolean;
  error: string | undefined;
}

interface Outbox {
  turn: Untold;
  compaction: Untold;
}

function isUntold(value: unknown): value is Untold {
  return (
    typeof value === "object" &&
    value !== null &&
    "clear" in value &&
    typeof value.clear === "boolean" &&
    "error" in value &&
    (value.error === undefined || typeof value.error === "string")
  );
}

function isOutbox(value: unknown): value is Outbox {
  return (
    typeof value === "object" &&
    value !== null &&
    "turn" in value &&
    isUntold(value.turn) &&
    "compaction" in value &&
    isUntold(value.compaction)
  );
}

function outbox(): Outbox {
  const found: unknown = Reflect.get(globalThis, KEY);
  if (isOutbox(found)) return found;
  const created: Outbox = {
    turn: { clear: false, error: undefined },
    compaction: { clear: false, error: undefined },
  };
  Reflect.set(globalThis, KEY, created);
  return created;
}

export class Failures {
  private failed: string | undefined;
  private readonly outbox = outbox();
  private compactionPending: string | undefined;
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

  flush(): void {
    for (const compaction of [false, true]) {
      const untold = this.untold(compaction);
      const { clear, error } = untold;
      untold.clear = false;
      untold.error = undefined;
      if (clear) this.recovered(compaction);
      if (error !== undefined) this.report(error, compaction, false);
    }
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
      this.recovered(true);
    });
    pi.on("agent_settled", (event) => {
      if (this.owed !== undefined) blockage.raise(this.owed, blockage.now);
      if (event.aborted) return;
      const pending = this.compactionPending;
      this.compactionPending = undefined;
      if (pending !== undefined && this.failed === undefined)
        this.raisePiFault(pending, true, blockage.now);
      if (this.failed !== undefined) this.report(this.failed, false, true);
      else this.recovered(false);
    });
  }

  private untold(compaction: boolean): Untold {
    return compaction ? this.outbox.compaction : this.outbox.turn;
  }

  private recovered(compaction: boolean): void {
    const untold = this.untold(compaction);
    untold.error = undefined;
    this.link.call("incident.clear", compaction ? { compacted: true } : {}).catch(() => {
      untold.clear = true;
    });
  }

  private report(error: string, compaction: boolean, blocks: boolean): void {
    const blockage = this.blockage;
    const since = blockage?.now ?? 0;
    const phase = compaction ? ({ phase: "compaction" } as const) : {};
    const resumeAt = routerResumeAt(error);
    const resume = resumeAt === undefined ? {} : { resumeAt };
    this.link.call("incident.report", { error, ...phase, ...resume }).then(
      () => {
        if (blocks) this.raisePiFault(error, compaction, since);
      },
      () => {
        this.untold(compaction).error = error;
        if (blocks) this.raisePiFault(error, compaction, since);
      },
    );
  }

  private raisePiFault(error: string, compaction: boolean, since: number): void {
    if (PI_FAULT.test(error)) this.blockage?.raise(failureLabel("stale-module", compaction), since);
  }
}
