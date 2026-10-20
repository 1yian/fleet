// Mate tools for questions and holds (spec sections 11.2 and 17). answer checks
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

export function registerQuestions(
  pi: ExtensionAPI,
  link: Link,
  sessionFile: () => string | undefined,
): void {
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
    parameters: Type.Object({ card: CardId, words: Type.String({ minLength: 1 }) }),
    execute: async (_id, params) => {
      const source = captainSaid(sessionFile(), params.words) ? "chat" : "record";
      return reply(
        `Recorded the answer. ${card(await link.call("answer", { ...params, source }))}`,
      );
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
