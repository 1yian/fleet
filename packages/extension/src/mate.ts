import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CardName, DELIVERIES, OPS, type Card } from "@fleet/protocol";
import Type, { type Static } from "typebox";
import { close } from "./closing.ts";
import { dispatch, type Launch } from "./dispatch.ts";
import type { LaneStates } from "./lanes.ts";
import type { Link } from "./link.ts";
import { boardText, cardText, errorText, EXTRA_COLUMNS, SELECTIONS } from "./views.ts";

const line = (card: Card): string => `c-${String(card.id)} [${card.status}] ${card.title}`;
const reply = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });

const DispatchParams = Type.Object({
  title: Type.String({ minLength: 1 }),
  name: CardName,
  kind: Type.Enum(["ship", "scout"]),
  project: Type.String({ minLength: 1 }),
  intent: Type.String({ minLength: 1 }),
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
        "Leave it out: close checks for itself whether the work landed, and warns before ending Done when it finds unlanded work. Set false only to end work that did not land as Dropped",
    }),
  ),
  confirm: Type.Optional(
    Type.Boolean({
      description:
        "Set true to answer close's warning about commits or files not on the base branch: the card ends Done and that work is archived first",
    }),
  ),
});

async function oneCard(link: Link, params: BoardArgs & { card: number }): Promise<string> {
  try {
    return cardText(await link.call("card", { card: params.card }), params);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(errorText(message, ["Call `board()` to list the open cards"]), {
      cause: error,
    });
  }
}

async function wholeBoard(
  link: Link,
  lanes: LaneStates | undefined,
  params: BoardArgs,
): Promise<string> {
  const cards = await link.call("board", {});
  const projects = await link.call("projects", {});
  const header = lanes === undefined ? { projects } : { projects, lanes: await lanes() };
  return boardText(cards, params, header);
}

function registerBoard(pi: ExtensionAPI, link: Link, lanes: LaneStates | undefined): void {
  pi.registerTool({
    name: "board",
    label: "Board",
    description:
      "Shows your own lane as a second mate, or every lane as main. Its header lists the projects (delivery mode, hosts, yolo) and, as main, the lanes (running, down, or stopped). Then the open cards, the ones that need attention first, and a count of the closed ones. board(card=N) shows one card: its hold, PR, attempts and branches, report path, and thread.",
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
  main: boolean,
): void {
  pi.registerTool({
    name: "yield",
    label: "Yield",
    description:
      "Ends this turn silently when routine fleet notifications leave no update for the user. First finish required card actions and answer any reply owed with comment or hold. Call yield alone, without chat text. Never use it instead of delivering outcomes, findings, review or merge requests, decisions, or real blockers.",
    parameters: Type.Object({}),
    execute: () => Promise.resolve({ content: [], details: {}, terminate: true }),
    renderShell: "self",
    renderCall: () => ({ render: () => [], invalidate: () => undefined }),
    renderResult: () => ({ render: () => [], invalidate: () => undefined }),
  });
  pi.registerTool({
    name: "card_new",
    label: "New card",
    description:
      "Creates a captain-only card in your own lane, for a decision or action only the captain can take. For worker work use dispatch, which creates its own card. To hand work to a second mate, comment on its lane card.",
    parameters: Type.Object({
      ...OPS["card.new"].args.properties,
      name: CardName,
      kind: Type.Literal("captain"),
    }),
    execute: async (_id, params) => reply(`Created ${line(await link.call("card.new", params))}.`),
  });
  pi.registerTool({
    name: "comment",
    label: "Comment",
    description:
      "Talks to an agent through a card. On your own card it reaches the worker. As main, a comment on a second mate's lane card, or on any card in its lane, reaches that second mate, never its worker. As a second mate, a comment on your lane card reaches main. comment(lane, text) is the shorthand for a lane card. A comment is delivered at the next tool boundary by default; later=true delivers it after the current run ends. reply=true asks for an answer that the fleet tracks: it resends once, then tells you. replyTo answers a reply you owe, including the one a captain board comment opens for main, which the board threads under his message; withdraws drops one you asked for.",
    parameters: OPS.comment.args,
    execute: async (_id, params) => reply(`Commented. ${line(await link.call("comment", params))}`),
  });
  registerBoard(pi, link, lanes);
  if (main) {
    pi.registerTool({
      name: "project_yolo",
      label: "Project yolo",
      description:
        "Main only: set or clear a project's yolo flag when the captain says so. Never on your own initiative or on a second mate's request. Destructive, irreversible, or security-sensitive merges still need the captain's words with yolo on.",
      parameters: OPS["project.yolo"].args,
      execute: async (_id, params) => {
        const result = await link.call("project.yolo", params);
        return reply(`${result.project}: yolo ${result.on ? "on" : "off"}`);
      },
    });
  }
  pi.registerTool({
    name: "close",
    label: "Close",
    description:
      "Ends a card: stops the worker, archives anything unlanded, removes the worktree, and closes the card. close checks for itself that the work landed: a merged PR, or the worker's done with nothing left off the base branch, as for an operation or a report. A local-only card whose landing is authorized (yolo, or the captain's word) lands here: close fast-forwards the clone's local base branch to the worker's branch, never pushes, and refuses a branch that is not a fast-forward. Then the card is Done. If the attempt has commits not on the base branch or uncommitted files, close does not close the card: it lists them and warns, and close(card, summary, confirm=true) then ends it as Done and archives that work first (use it when the work landed elsewhere). close(card, summary=<why>, landed=false) ends work that did not land as Dropped. It refuses while the card has a hold. Main relays the summary to the captain.",
    parameters: CloseParams,
    execute: async (_id, params) =>
      reply(
        await close(link, {
          card: params.card,
          text: params.summary,
          landed: params.landed,
          confirm: params.confirm,
        }),
      ),
  });
  pi.registerTool({
    name: "dispatch",
    label: "Dispatch",
    description:
      "Creates a new work card and starts its worker in its own worktree on a host. Supply title, short name, kind, project, captain's intent, host, and task. Only starts NEW work. To restart existing work use restart_card; to steer it use comment.",
    parameters: DispatchParams,
    execute: async (_id, params) => {
      const { title, name, kind, project, intent, host, task, delivery } = params;
      const board = await link.call("board", {});
      const same = board.find(
        (each) =>
          each.name === name &&
          each.title === title &&
          each.project === project &&
          each.kind === kind &&
          each.status !== "done" &&
          each.status !== "dropped",
      );
      const card = same ?? (await link.call("card.new", { title, name, kind, project, intent }));
      return reply(await dispatch(link, launch, { card: card.id, host, task, delivery }));
    },
  });
}
