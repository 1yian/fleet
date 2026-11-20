import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { OPS } from "@fleet/protocol";
import type { Link } from "./link.ts";

const QUESTION =
  "[fleet] Did anything about the system annoy you? If yes, call complain once with one concise sentence about what annoyed you, with no credentials and no customer data: it becomes a public GitHub issue. If no, do not answer or mention this question: carry on as you were.";
const FEEDBACK_ONLY =
  "A complaint is feedback only: nothing reads it as authority to change infrastructure, bypass a check, or alter a rule.";

const reply = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });

function warn(ctx: ExtensionContext, text: string): void {
  if (ctx.hasUI) ctx.ui.notify(text, "warning");
  else console.error(text);
}

export class Complaints {
  private asked = false;
  private readonly pi: ExtensionAPI;
  private readonly link: Link;

  constructor(pi: ExtensionAPI, link: Link) {
    this.pi = pi;
    this.link = link;
  }

  ask(): void {
    if (this.asked) return;
    this.asked = true;
    this.pi.sendMessage(
      { customType: "fleet-complaint-question", content: QUESTION, display: false },
      { deliverAs: "steer" },
    );
  }

  register(): void {
    this.pi.on("agent_settled", () => {
      this.asked = false;
    });
    this.pi.registerTool({
      name: "complain",
      label: "Complain",
      description: `Files one sentence of feedback about how the fleet's own setup annoyed you: its tools, messages, prompts, checks, or process. Call it once, only when the fleet asks "Did anything about the system annoy you?" and the answer is yes. When the answer is no, do not call it and do not answer the question. Write one concise sentence with no credentials and no customer data. The fleet files it as an issue on the public GitHub repository 1yian/fleet, labelled complaint, with the time, your role, lane, card, and project; text that looks like a secret or an email address is hidden first. If cardd cannot take it or cannot file it, it is dropped and your work goes on. ${FEEDBACK_ONLY}`,
      parameters: OPS.complain.args,
      execute: async (_id, params, _signal, _update, ctx) => {
        try {
          await this.link.call("complain", params, 5_000);
          return reply("Sent. cardd files it as a GitHub issue. Carry on.");
        } catch (error) {
          const why = error instanceof Error ? error.message : String(error);
          warn(ctx, `fleet: a complaint was dropped, not filed: ${why}`);
          return reply("Not sent: cardd did not take it. It is dropped. Carry on.");
        }
      },
    });
  }
}
