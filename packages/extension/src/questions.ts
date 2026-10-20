// Mate tools for questions, holds, grants, and merges (spec sections 11.2, 17, 18, and 20.4). answer checks
// the captain's words where it can see them: a user-role message in this mate's
// own session file. Otherwise cardd looks for them in the captain's board entries.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CardSchema, check } from "@fleet/protocol";
import Type from "typebox";
import { captainSaid, parseUtc } from "./inbox.ts";
import type { Link } from "./link.ts";

const CardId = Type.Integer({ description: "The card number, such as 12 for c-12" });

const card = (value: unknown): string => {
  const parsed = check(CardSchema, value);
  return `c-${String(parsed.id)} is now ${parsed.status}.`;
};
const reply = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });

/** chat when the words are in this session's own user messages; otherwise cardd checks the record. */
const sourceFrom =
  (sessionFile: () => string | undefined) =>
  (words: string): "chat" | "record" =>
    captainSaid(sessionFile(), words) ? "chat" : "record";

export function registerQuestions(
  pi: ExtensionAPI,
  link: Link,
  sessionFile: () => string | undefined,
): void {
  /** chat when the words are in this session's own user messages; otherwise cardd checks the record. */
  const sourceOf = (words: string): "chat" | "record" =>
    captainSaid(sessionFile(), words) ? "chat" : "record";
  pi.registerTool({
    name: "ask",
    label: "Ask the captain",
    description:
      "Asks the captain a question on a card: evidence, consequence, options, and a recommendation. A second mate's question goes to main first.",
    parameters: Type.Object({
      card: CardId,
      question: Type.String({ minLength: 1 }),
      options: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    }),
    execute: async (_id, params) => reply(`Asked. ${card(await link.call("ask", params))}`),
  });
  pi.registerTool({
    name: "answer",
    label: "Record the captain's answer",
    description: "Records the captain's exact words as the answer to the open question on a card.",
    parameters: Type.Object({
      card: CardId,
      words: Type.String({ minLength: 1 }),
      choice: Type.Optional(
        Type.String({ description: "For a merge question: Approve & merge, or Request changes" }),
      ),
    }),
    execute: async (_id, params) => {
      const source = sourceOf(params.words);
      return reply(
        `Recorded the answer. ${card(await link.call("answer", { ...params, source }))}`,
      );
    },
  });
}

/** grant and merge: both act on the captain's authority. */
export function registerAuthority(
  pi: ExtensionAPI,
  link: Link,
  sessionFile: () => string | undefined,
): void {
  const sourceOf = sourceFrom(sessionFile);
  pi.registerTool({
    name: "grant",
    label: "Record a grant",
    description:
      "Sets a grant on a lane or a card with the captain's exact words. Never widen a grant by analogy. Set merge only when the words allow merging.",
    parameters: Type.Object({
      lane: Type.Optional(Type.String()),
      card: Type.Optional(CardId),
      words: Type.String({ minLength: 1 }),
      may: Type.String({ minLength: 1, description: "What may happen without asking" }),
      merge: Type.Boolean({ description: "Whether the grant covers merging" }),
      limits: Type.Optional(Type.String()),
      always_asks: Type.Optional(Type.String()),
      project: Type.Optional(Type.String({ description: "Limit the grant to this project" })),
      branch: Type.Optional(Type.String({ description: "Limit the grant to this target branch" })),
      expires: Type.Optional(Type.String({ description: "ISO 8601 time with Z or an offset" })),
    }),
    execute: async (_id, { always_asks, expires, ...params }) => {
      const args = {
        ...params,
        source: sourceOf(params.words),
        ...(always_asks === undefined ? {} : { alwaysAsks: always_asks }),
        ...(expires === undefined ? {} : { expires: parseUtc(expires) }),
      };
      await link.call("grant", args);
      return reply("Recorded the grant.");
    },
  });
  pi.registerTool({
    name: "merge",
    label: "Merge",
    description:
      "Merges a card's PR through the guarded path. It needs a grant, the captain's approval, or the captain's quoted words. It refuses red or pending checks.",
    parameters: Type.Object({ card: CardId, words: Type.Optional(Type.String({ minLength: 1 })) }),
    execute: async (_id, params) => {
      const args =
        params.words === undefined ? params : { ...params, source: sourceOf(params.words) };
      return reply(`Merged. ${card(await link.call("merge", args))}`);
    },
  });
  pi.registerTool({
    name: "handback",
    label: "Hand a question back",
    description:
      "Main only: returns a second mate's question to that mate with guidance, when it is not the captain's to decide.",
    parameters: Type.Object({ card: CardId, guidance: Type.String({ minLength: 1 }) }),
    execute: async (_id, params) =>
      reply(`Handed back. ${card(await link.call("handback", params))}`),
  });
  pi.registerTool({
    name: "card_hold",
    label: "Hold a card",
    description:
      "Moves a card to Waiting until a date. On that date it returns to its current status.",
    parameters: Type.Object({
      card: CardId,
      until: Type.String({
        description: "ISO 8601 time with Z or an offset, like 2026-05-01T10:00:00Z",
      }),
      reason: Type.String({ minLength: 1 }),
    }),
    execute: async (_id, params) => {
      const until = parseUtc(params.until);
      return reply(`Held. ${card(await link.call("hold", { ...params, until }))}`);
    },
  });
}
