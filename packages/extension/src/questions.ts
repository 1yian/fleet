import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CardSchema, check, OPS } from "@fleet/protocol";
import Type, { type Static } from "typebox";
import { captainSaid, parseUtc } from "./inbox.ts";
import type { Link } from "./link.ts";

const CardId = Type.Integer({ description: "The card number, such as 12 for c-12" });

const card = (value: unknown): string => {
  const parsed = check(CardSchema, value);
  return `c-${String(parsed.id)} is now ${parsed.status}.`;
};
const reply = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });

const HoldParams = Type.Object({
  card: CardId,
  question: Type.Optional(OPS.hold.args.properties.question),
  options: OPS.hold.args.properties.options,
  to: OPS.hold.args.properties.to,
  replyTo: OPS.hold.args.properties.replyTo,
  until: Type.Optional(
    Type.String({ description: "ISO 8601 time with Z or an offset, like 2026-05-01T10:00:00Z" }),
  ),
  clear: Type.Optional(
    Type.Boolean({
      description:
        "Clears the card's hold instead of setting it. Give words or note, and choice for a merge question",
    }),
  ),
  words: Type.Optional(
    Type.String({
      pattern: "\\S",
      description:
        "With clear: the captain's exact words, when the captain decided it, and for a merge approval",
    }),
  ),
  note: Type.Optional(
    Type.String({
      minLength: 1,
      description: "With clear: your own decision, when it was yours or main's to decide",
    }),
  ),
  choice: Type.Optional(
    Type.String({
      description: "With clear, for a merge question: Approve & merge, or Request changes",
    }),
  ),
});

const SETTING = ["question", "options", "to", "until", "replyTo"] as const;
const CLEARING = ["words", "note", "choice"] as const;

type HoldArgs = Static<typeof HoldParams>;

export function registerQuestions(
  pi: ExtensionAPI,
  link: Link,
  sessionFile: () => string | undefined,
): void {
  const sourceOf = (words: string): "chat" | "record" =>
    captainSaid(sessionFile(), words) ? "chat" : "record";
  const clearHold = async (params: HoldArgs): Promise<string> => {
    const extra = SETTING.filter((key) => params[key] !== undefined);
    if (extra.length > 0)
      throw new Error(`clear=true takes words or note, not ${extra.join(", ")}`);
    const { card: id, words, note, choice } = params;
    const args = {
      card: id,
      ...(words === undefined ? {} : { words, source: sourceOf(words) }),
      ...(note === undefined ? {} : { note }),
      ...(choice === undefined ? {} : { choice }),
    };
    return `Cleared. ${card(await link.call("release", args))}`;
  };
  const setHold = async (params: HoldArgs): Promise<string> => {
    const extra = CLEARING.filter((key) => params[key] !== undefined);
    if (extra.length > 0) throw new Error(`${extra.join(", ")} only go with clear=true`);
    const { card: id, question, options, to, until, replyTo } = params;
    if (question === undefined) throw new Error("a hold needs its question");
    const args = {
      card: id,
      question,
      ...(options === undefined ? {} : { options }),
      ...(to === undefined ? {} : { to }),
      ...(until === undefined ? {} : { until: parseUtc(until) }),
      ...(replyTo === undefined ? {} : { replyTo }),
    };
    return `Held. ${card(await link.call("hold", args))}`;
  };
  pi.registerTool({
    name: "hold",
    label: "Hold",
    description:
      "Holds a card at a gate, with every question of the gate bundled in one hold: the evidence, the consequence, the options, and your recommendation. A card has one hold, so holding it again rewrites the same hold. A second mate's hold waits on main. Main's hold waits on the captain, and main escalates a second mate's hold with to=captain. until holds it until a date, such as when the captain says later. clear=true clears the hold: with words, the captain's exact words, when he decided it, or with note, your own decision when it was yours or main's. Words are checked against what the captain wrote. replyTo answers a reply you owe with this hold.",
    parameters: HoldParams,
    execute: async (_id, params) =>
      reply(params.clear === true ? await clearHold(params) : await setHold(params)),
  });
}
