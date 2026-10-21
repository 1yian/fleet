// Mate tools for holds and grants (spec sections 11.2, 17, and 18). release checks
// the captain's words where it can see them: a user-role message in this mate's
// own session file. Otherwise cardd looks for them in the captain's board entries.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CardSchema, check, OPS, Words } from "@fleet/protocol";
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
  const sourceOf = sourceFrom(sessionFile);
  pi.registerTool({
    name: "hold",
    label: "Hold a card",
    description:
      "Holds a card at a gate, with every question of the gate bundled in one hold: the evidence, the consequence, the options, and your recommendation. A card has one hold, so holding it again rewrites the same hold. A second mate's hold waits on main. Main's hold waits on the captain, and main escalates a second mate's hold with to=captain. until holds it until a date, such as when the captain says later.",
    parameters: Type.Object({
      ...OPS.hold.args.properties,
      until: Type.Optional(
        Type.String({
          description: "ISO 8601 time with Z or an offset, like 2026-05-01T10:00:00Z",
        }),
      ),
    }),
    execute: async (_id, params) => {
      const until = params.until === undefined ? undefined : parseUtc(params.until);
      const args = { ...params, ...(until === undefined ? {} : { until }) };
      return reply(`Held. ${card(await link.call("hold", args))}`);
    },
  });
  pi.registerTool({
    name: "release",
    label: "Release a hold",
    description:
      "Releases the card's hold. Give words, the captain's exact words, when the captain decided it, and for a merge approval. Give note, your own decision, when it was yours or main's to decide. Words are checked against what the captain wrote.",
    parameters: Type.Object({
      card: CardId,
      words: Type.Optional(Words),
      note: Type.Optional(Type.String({ minLength: 1 })),
      choice: Type.Optional(
        Type.String({ description: "For a merge hold: Approve & merge, or Request changes" }),
      ),
    }),
    execute: async (_id, params) => {
      const source = params.words === undefined ? undefined : sourceOf(params.words);
      const args = { ...params, ...(source === undefined ? {} : { source }) };
      return reply(`Released. ${card(await link.call("release", args))}`);
    },
  });
}

/** grant: acts on the captain's authority. */
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
      words: Words,
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
}
