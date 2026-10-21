import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CardName, CardSchema, check, DELIVERIES, OPS, type Card } from "@fleet/protocol";
import Type, { type Static } from "typebox";
import { close } from "./closing.ts";
import { dispatch, type Launch } from "./dispatch.ts";
import type { LaneStates } from "./lanes.ts";
import type { Link } from "./link.ts";
import { boardText, cardText, errorText, EXTRA_COLUMNS, SELECTIONS } from "./views.ts";

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
    description:
      "The task message: the captain's intent and the spec. Dispatch adds the Delivery line from the card",
  }),
  delivery: Type.Optional(
    Type.Enum(DELIVERIES, {
      description:
        "Only when the captain asked for another mode for this work: records it on the ship card. Otherwise the card keeps its project's mode",
    }),
  ),
  replace: Type.Optional(Type.Boolean({ description: "Replace a live attempt on another host" })),
});

const BoardParams = Type.Object({
  card: Type.Optional(
    Type.Integer({
      description:
        "Shows this one card: its hold, PR, attempts and branches, report path, and thread, newest first",
    }),
  ),
  entries: Type.Optional(
    Type.Integer({
      minimum: 1,
      description: "With card: how many thread entries to show, newest first (10)",
    }),
  ),
  full: Type.Optional(
    Type.Boolean({ description: "With card: show every text whole, without cutting it" }),
  ),
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
  projects: Type.Optional(
    Type.Boolean({ description: "List every registered project, with its base branch" }),
  ),
  lanes: Type.Optional(
    Type.Boolean({
      description: "As main: list every lane with its host and why it is in its state",
    }),
  ),
});
type BoardArgs = Static<typeof BoardParams>;

const CloseParams = Type.Object({
  card: Type.Integer(),
  summary: Type.String({
    minLength: 1,
    description:
      "What landed, as the captain should hear it. With landed=false: why the work is dropped",
  }),
  landed: Type.Optional(
    Type.Boolean({
      description:
        "Leave it out: close checks for itself whether the work landed, and refuses Done when it did not. Set false only to end work that did not land as Dropped",
    }),
  ),
});

async function oneCard(link: Link, params: BoardArgs & { card: number }): Promise<string> {
  let value: unknown;
  try {
    value = await link.call("card", { card: params.card });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(errorText(message, ["Call `board()` to list the open cards"]), {
      cause: error,
    });
  }
  return cardText(check(OPS.card.result, value), params);
}

async function wholeBoard(
  link: Link,
  lanes: LaneStates | undefined,
  params: BoardArgs,
): Promise<string> {
  const cards = check(OPS.board.result, await link.call("board", {}));
  const projects = check(OPS.projects.result, await link.call("projects", {}));
  const header = lanes === undefined ? { projects } : { projects, lanes: await lanes() };
  return boardText(cards, params, header);
}

function registerBoard(pi: ExtensionAPI, link: Link, lanes: LaneStates | undefined): void {
  pi.registerTool({
    name: "board",
    label: "Board",
    description:
      "Shows the fleet. Its header lists the projects (delivery mode, hosts, yolo) and, as main, the lanes (running, down, or stopped). Then the open cards, the ones that need attention first, and a count of the closed ones. board(card=N) shows one card: its hold, PR, attempts and branches, report path, and thread.",
    parameters: BoardParams,
    execute: async (_id, params) => {
      const { card } = params;
      return reply(
        card === undefined
          ? await wholeBoard(link, lanes, params)
          : await oneCard(link, { ...params, card }),
      );
    },
  });
}

export function registerMate(
  pi: ExtensionAPI,
  link: Link,
  launch: Launch,
  lanes: LaneStates | undefined,
): void {
  pi.registerTool({
    name: "card_new",
    label: "New card",
    description:
      "Creates a card in your own lane. A card must exist before any work starts. As main, never use lane: to hand work to a second mate, comment on its lane card.",
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
  registerBoard(pi, link, lanes);
  pi.registerTool({
    name: "close",
    label: "Close",
    description:
      "Ends a card: stops the worker, archives anything unlanded, removes the worktree, and closes the card. close checks for itself that the work landed: a merged PR, or the worker's done with nothing left off the base branch, as for an operation or a report. A local-only card whose landing is authorized (yolo, or the captain's word) lands here: close fast-forwards the clone's local base branch to the worker's branch, never pushes, and refuses a branch that is not a fast-forward. Then the card is Done. If the work did not land it refuses, and close(card, summary=<why>, landed=false) ends it as Dropped. It refuses while the card has a hold. Main relays the summary to the captain.",
    parameters: CloseParams,
    execute: async (_id, params) =>
      reply(await close(link, { card: params.card, text: params.summary, landed: params.landed })),
  });
  pi.registerTool({
    name: "dispatch",
    label: "Dispatch",
    description:
      "Starts a worker for a card in its own worktree on a host, and sends it the task message with the card's delivery mode.",
    parameters: DispatchParams,
    execute: async (_id, params) =>
      reply(await dispatch(link, launch, { ...params, replace: params.replace ?? false })),
  });
}
