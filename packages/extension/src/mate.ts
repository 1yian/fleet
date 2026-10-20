// Mate sessions: the card tools and dispatch (spec section 11.2).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CardSchema, check, OPS, type Card } from "@fleet/protocol";
import Type from "typebox";
import { close } from "./closing.ts";
import { dispatch, type Launch } from "./dispatch.ts";
import type { Link } from "./link.ts";

const line = (card: Card): string => `c-${String(card.id)} [${card.status}] ${card.title}`;
const reply = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });

const DispatchParams = Type.Object({
  card: Type.Integer(),
  host: Type.String({
    minLength: 1,
    description: "The host to run the worker on, such as maverick or p620",
  }),
  task: Type.String({
    minLength: 1,
    description: "The task message: the outcome, the spec, and the delivery mode",
  }),
  replace: Type.Optional(Type.Boolean({ description: "Replace a live attempt on another host" })),
});

export function registerMate(pi: ExtensionAPI, link: Link, launch: Launch): void {
  pi.registerTool({
    name: "card_new",
    label: "New card",
    description: "Creates a card. A card must exist before any work starts.",
    parameters: OPS["card.new"].args,
    execute: async (_id, params) =>
      reply(`Created ${line(check(CardSchema, await link.call("card.new", params)))}.`),
  });
  pi.registerTool({
    name: "comment",
    label: "Comment",
    description:
      "Sends a steer or an answer to the worker on a card. now delivers at the next tool boundary.",
    parameters: OPS.comment.args,
    execute: async (_id, params) =>
      reply(`Commented. ${line(check(CardSchema, await link.call("comment", params)))}`),
  });
  pi.registerTool({
    name: "projects",
    label: "Projects",
    description:
      "Lists the registered projects: delivery mode, base branch, and the hosts that have a clone.",
    parameters: OPS.projects.args,
    execute: async () => {
      const list = check(OPS.projects.result, await link.call("projects", {}));
      const lines = list.map(
        (each) =>
          `${each.name}: delivery ${each.delivery}, base ${each.base}, hosts ${each.hosts.join(", ")}`,
      );
      return reply(lines.length === 0 ? "No projects are registered." : lines.join("\n"));
    },
  });
  pi.registerTool({
    name: "board",
    label: "Board",
    description: "Lists the cards.",
    parameters: OPS.board.args,
    execute: async () => {
      const cards = check(OPS.board.result, await link.call("board", {}));
      return reply(cards.length === 0 ? "No cards." : cards.map(line).join("\n"));
    },
  });
  pi.registerTool({
    name: "cleanup",
    label: "Clean up",
    description:
      "Ends a card whose work landed (a merged PR or a delivered report): stops the worker, archives anything unlanded, removes the worktree, and marks it Done. Main relays the summary to the captain.",
    parameters: Type.Object({ card: Type.Integer(), summary: Type.String({ minLength: 1 }) }),
    execute: async (_id, params) =>
      reply(await close(link, { card: params.card, mode: "done", text: params.summary })),
  });
  pi.registerTool({
    name: "card_drop",
    label: "Drop a card",
    description:
      "Ends a card that did not land: stops the worker, archives its unlanded work, removes the worktree, and marks it Dropped. The reason is required.",
    parameters: Type.Object({ card: Type.Integer(), reason: Type.String({ minLength: 1 }) }),
    execute: async (_id, params) =>
      reply(await close(link, { card: params.card, mode: "dropped", text: params.reason })),
  });
  pi.registerTool({
    name: "dispatch",
    label: "Dispatch",
    description:
      "Starts a worker for a card in its own worktree on a host, and sends it the task message.",
    parameters: DispatchParams,
    execute: async (_id, params) =>
      reply(await dispatch(link, launch, { ...params, replace: params.replace ?? false })),
  });
}
