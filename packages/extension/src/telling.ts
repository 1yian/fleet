import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { OPS, PresentedCardSchema, type OpResult } from "@fleet/protocol";
import { textOf } from "./inbox.ts";
import type { Link } from "./link.ts";

const PRESENTED = "presented";
const AFK = /\bafk\b/i;
const MARK_DEADLINE_MS = 2_000;
const DUE_DEADLINE_MS = 5_000;

const reply = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });

type Due = NonNullable<OpResult<"decision.due">>;

function dueRefusal(due: Due): string {
  const others =
    due.waiting === 0 ? "" : ` and "+${String(due.waiting)} more waiting" for the others`;
  return `yield refused: the captain has written to you since you last brought a decision up, and c-${String(due.card)} ${due.title} is due: ${due.question}\nAnswer him first, then end your reply with this one decision and your recommendation${others}. Call presented(card=${String(due.card)}) in the same turn, and yield only if nothing else is left. Bring up no other decision.`;
}

type Presented = OpResult<"presented">;

interface Shown {
  readonly card: number;
  readonly occurrence: number;
}

type Outgoing =
  | { readonly op: "captain.seen"; readonly args: { readonly away: boolean } }
  | {
      readonly op: typeof PRESENTED;
      readonly args: Shown;
      readonly done?: (outcome: Presented | Error) => void;
    };

const unrecorded = (what: string, error: unknown): Error =>
  new Error(
    `${what} refused: the captain's messages or what you brought up to him could not be recorded yet (${error instanceof Error ? error.message : String(error)}). They are kept and recorded in order once cardd answers. Try again shortly.`,
  );

const UNWRITTEN_YIELD =
  "yield refused: you called presented but wrote no chat text in this turn. A decision counts as shown only when you wrote it to the captain. Write it now, with your recommendation.";

const UNWRITTEN_PRESENTED =
  "presented refused: this turn ends silently with yield and has no chat text, so the decision would be marked as shown without being written to the captain. Write it first.";

export class Telling {
  private marked = false;
  private yielded = false;
  private written = false;
  private readonly pending = new Map<number, number>();
  private readonly outbox: Outgoing[] = [];
  private recording: Promise<void> = Promise.resolve();
  private readonly pi: ExtensionAPI;
  private readonly link: Link;

  constructor(pi: ExtensionAPI, link: Link) {
    this.pi = pi;
    this.link = link;
  }

  register(): void {
    this.registerWalkthrough();
    this.pi.events.on("fleet:connected", () => {
      void this.record().catch(() => undefined);
    });
    this.pi.on("input", async (event) => {
      if (event.source !== "interactive") return undefined;
      this.outbox.push({ op: "captain.seen", args: { away: AFK.test(event.text) } });
      await this.record().catch(() => undefined);
      return undefined;
    });
    this.pi.on("agent_start", () => {
      this.marked = false;
      this.yielded = false;
      this.written = false;
      this.pending.clear();
    });
    this.pi.on("message_end", async (event) => {
      if (event.message.role !== "assistant" || textOf(event.message).trim() === "") return;
      this.written = true;
      for (const [card, occurrence] of this.pending)
        this.outbox.push({ op: PRESENTED, args: { card, occurrence } });
      this.pending.clear();
      await this.record().catch(() => undefined);
    });
    this.pi.on("tool_call", (event) => {
      if (event.toolName === PRESENTED) this.marked = true;
      return undefined;
    });
    this.pi.registerTool({
      name: PRESENTED,
      label: "Presented",
      description:
        "Main only: records that your chat message to the captain in this turn brings up the decision on this card, which waits on him. Call it in the same turn as that message, once for each decision you bring up. Bring up one decision in a message, never several. The fleet uses it to pick the next decision to bring up and to refuse yield while one is due. Refused when the card does not wait on the captain, and refused in a turn that ends silently with yield and has no chat text.",
      parameters: PresentedCardSchema,
      execute: async (_id, params) => {
        if (this.yielded && !this.written) throw new Error(UNWRITTEN_PRESENTED);
        const { hold } = await this.link.call("card", params);
        if (hold?.holder !== "captain")
          throw new Error(`c-${String(params.card)} is not waiting on the captain`);
        const { occurrence } = hold;
        if (!this.written) {
          this.pending.set(params.card, occurrence);
          return reply(
            "Pending: write this decision to the captain in this turn to record it as shown.",
          );
        }
        const answer: { outcome?: Presented | Error } = {};
        this.outbox.push({
          op: PRESENTED,
          args: { ...params, occurrence },
          done: (outcome) => {
            answer.outcome = outcome;
          },
        });
        await this.record().catch(() => undefined);
        const { outcome } = answer;
        if (outcome === undefined)
          return reply(
            "Pending: cardd did not take the mark yet. It is kept and recorded before your next yield.",
          );
        if (outcome instanceof Error) throw outcome;
        const { card, waiting } = outcome;
        const rest =
          waiting === 0
            ? "No other decision waits on him."
            : `${String(waiting)} more wait: say "+${String(waiting)} more waiting".`;
        return reply(`Recorded: c-${String(card)} was brought up to the captain. ${rest}`);
      },
    });
  }

  private registerWalkthrough(): void {
    this.pi.registerTool({
      name: "walkthrough",
      label: "Walkthrough",
      description:
        "Main only: records that the captain paused or stopped the decision walkthrough (paused=true), or asked to resume it (paused=false). While it is paused no decision is due and yield is not refused for one. Holds stay as they are, and the pause is not a message from him. Resume only when he asks. Chat from him on another subject, a routine wake, or a new decision does not resume it.",
      parameters: OPS.walkthrough.args,
      execute: async (_id, params) => {
        await this.record().catch((error: unknown) => {
          throw unrecorded("walkthrough", error);
        });
        const { paused } = await this.link.call("walkthrough", params, MARK_DEADLINE_MS);
        return reply(
          paused
            ? "Recorded: the walkthrough is paused. No decision is due until he asks to resume it."
            : "Recorded: the walkthrough is resumed.",
        );
      },
    });
  }

  private async send(item: Outgoing): Promise<void> {
    if (item.op === "captain.seen") {
      await this.link.call(item.op, item.args, MARK_DEADLINE_MS);
      return;
    }
    try {
      const result = await this.link.call(item.op, item.args, MARK_DEADLINE_MS);
      item.done?.(result);
    } catch (error) {
      if (!(await this.obsolete(item.args))) throw error;
      item.done?.(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private async obsolete({ card, occurrence }: Shown): Promise<boolean> {
    const { hold } = await this.link.call("card", { card }, DUE_DEADLINE_MS);
    return (
      hold?.holder !== "captain" ||
      hold.occurrence !== occurrence ||
      (hold.until !== null && hold.until > Date.now())
    );
  }

  private record(): Promise<void> {
    const run = this.recording.then(async () => {
      for (let next = this.outbox[0]; next !== undefined; next = this.outbox[0]) {
        await this.send(next);
        this.outbox.shift();
      }
    });
    this.recording = run.catch(() => undefined);
    return run;
  }

  async allowYield(): Promise<void> {
    if (this.marked && !this.written) throw new Error(UNWRITTEN_YIELD);
    await this.record().catch((error: unknown) => {
      throw unrecorded("yield", error);
    });
    const due = await this.link.call("decision.due", {}, DUE_DEADLINE_MS);
    if (due !== null) throw new Error(dueRefusal(due));
    this.yielded = true;
  }
}
