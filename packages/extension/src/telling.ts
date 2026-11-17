import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { OPS, type OpResult } from "@fleet/protocol";
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

const UNWRITTEN_YIELD =
  "yield refused: you called presented but wrote no chat text in this turn. A decision counts as shown only when you wrote it to the captain. Write it now, with your recommendation.";

const UNWRITTEN_PRESENTED =
  "presented refused: this turn ends silently with yield and has no chat text, so the decision would be marked as shown without being written to the captain. Write it first.";

export class Telling {
  private marked = false;
  private yielded = false;
  private written = false;
  private readonly pending = new Set<number>();
  private readonly pi: ExtensionAPI;
  private readonly link: Link;

  constructor(pi: ExtensionAPI, link: Link) {
    this.pi = pi;
    this.link = link;
  }

  register(): void {
    this.pi.on("input", async (event) => {
      if (event.source !== "interactive") return undefined;
      const away = AFK.test(event.text);
      await this.link.call("captain.seen", { away }, MARK_DEADLINE_MS).catch(() => undefined);
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
      for (const card of this.pending) {
        await this.link.call(PRESENTED, { card });
        this.pending.delete(card);
      }
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
      parameters: OPS.presented.args,
      execute: async (_id, params) => {
        if (this.yielded && !this.written) throw new Error(UNWRITTEN_PRESENTED);
        if (!this.written) {
          const { hold } = await this.link.call("card", params);
          if (hold?.holder !== "captain")
            throw new Error(`c-${String(params.card)} is not waiting on the captain`);
          this.pending.add(params.card);
          return reply(
            "Pending: write this decision to the captain in this turn to record it as shown.",
          );
        }
        const { card, waiting } = await this.link.call(PRESENTED, params);
        const rest =
          waiting === 0
            ? "No other decision waits on him."
            : `${String(waiting)} more wait: say "+${String(waiting)} more waiting".`;
        return reply(`Recorded: c-${String(card)} was brought up to the captain. ${rest}`);
      },
    });
  }

  async allowYield(): Promise<void> {
    if (this.marked && !this.written) throw new Error(UNWRITTEN_YIELD);
    const due = await this.link.call("decision.due", {}, DUE_DEADLINE_MS);
    if (due !== null) throw new Error(dueRefusal(due));
    this.yielded = true;
  }
}
