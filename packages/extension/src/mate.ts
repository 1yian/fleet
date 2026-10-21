// Mate sessions: the card tools and dispatch (spec section 11.2).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CardName, CardSchema, check, OPS, type Card } from "@fleet/protocol";
import Type from "typebox";
import { close } from "./closing.ts";
import { dispatch, type Launch } from "./dispatch.ts";
import type { Link } from "./link.ts";
import {
  boardText,
  cardText,
  errorText,
  EXTRA_COLUMNS,
  projectsText,
  SELECTIONS,
} from "./views.ts";

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

const BoardParams = Type.Object({
  status: Type.Optional(
    Type.Enum(SELECTIONS, {
      description: "Which cards to list: open (the default), closed, all, or one status",
    }),
  ),
  lane: Type.Optional(Type.String({ minLength: 1, description: "Only this lane's cards" })),
  limit: Type.Optional(
    Type.Integer({ minimum: 0, description: "The most closed cards to list, newest first (10)" }),
  ),
  fields: Type.Optional(
    Type.String({
      description: `More columns, comma separated, from: ${EXTRA_COLUMNS.join(", ")}`,
    }),
  ),
});

const CardParams = Type.Object({
  card: Type.Integer({ description: "The card number, such as 12 for c-12" }),
  entries: Type.Optional(
    Type.Integer({ minimum: 1, description: "How many thread entries to show, newest first (10)" }),
  ),
  full: Type.Optional(Type.Boolean({ description: "Show every text whole, without cutting it" })),
});

/** The tools that read the fleet: projects, the board, and one card. They print TOON (views.ts). */
function registerReads(pi: ExtensionAPI, link: Link): void {
  pi.registerTool({
    name: "projects",
    label: "Projects",
    description:
      "Lists the registered projects: delivery mode, base branch, and the hosts that have a clone.",
    parameters: OPS.projects.args,
    execute: async () =>
      reply(projectsText(check(OPS.projects.result, await link.call("projects", {})))),
  });
  pi.registerTool({
    name: "board",
    label: "Board",
    description:
      "Shows the open cards, the ones that need attention first, and counts the closed ones. Read one card with the card tool.",
    parameters: BoardParams,
    execute: async (_id, params) =>
      reply(boardText(check(OPS.board.result, await link.call("board", {})), params)),
  });
  pi.registerTool({
    name: "card",
    label: "Card",
    description:
      "Shows one card: who its hold waits on and its question, its PR, its attempts and branches, the report path, and its thread newest first.",
    parameters: CardParams,
    execute: async (_id, params) => {
      let value: unknown;
      try {
        value = await link.call("card", { card: params.card });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(errorText(message, ["Call `board()` to list the open cards"]), {
          cause: error,
        });
      }
      return reply(cardText(check(OPS.card.result, value), params));
    },
  });
}

export function registerMate(pi: ExtensionAPI, link: Link, launch: Launch): void {
  pi.registerTool({
    name: "card_new",
    label: "New card",
    description:
      "Creates a card in your own lane. A card must exist before any work starts. As main, never use lane: to hand work to a second mate, comment on its lane card.",
    // The mate always names its cards; cardd also accepts cards without a name.
    parameters: Type.Object({ ...OPS["card.new"].args.properties, name: CardName }),
    execute: async (_id, params) =>
      reply(`Created ${line(check(CardSchema, await link.call("card.new", params)))}.`),
  });
  pi.registerTool({
    name: "comment",
    label: "Comment",
    description:
      "Talks to an agent through a card. On your own card it reaches the worker. As main, a comment on a second mate's lane card, or on any card in its lane, reaches that second mate, never its worker. As a second mate, a comment on your lane card reaches main. comment(lane, text) is the shorthand for a lane card. now delivers at the next tool boundary.",
    parameters: OPS.comment.args,
    execute: async (_id, params) =>
      reply(`Commented. ${line(check(CardSchema, await link.call("comment", params)))}`),
  });
  registerReads(pi, link);
  pi.registerTool({
    name: "cleanup",
    label: "Clean up",
    description:
      "Ends a card whose work landed: stops the worker, archives anything left over, removes the worktree, and marks it Done. Needs the worker's done, and a merged PR for a ship card. A ship card that made no code change, such as an operation, closes with without_pr set, and its worktree must have nothing unlanded. Main relays the summary to the captain.",
    parameters: Type.Object({
      card: Type.Integer(),
      summary: Type.String({ minLength: 1 }),
      without_pr: Type.Optional(
        Type.Boolean({
          description:
            "A ship card with no merged PR: it made no code change, or its commits are already on the base branch. Say so in the summary.",
        }),
      ),
    }),
    execute: async (_id, params) =>
      reply(
        await close(link, {
          card: params.card,
          mode: "done",
          text: params.summary,
          withoutPr: params.without_pr === true,
        }),
      ),
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
