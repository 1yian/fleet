import Type from "typebox";
import { PR_PATTERN } from "./report.ts";

export const APPROVE_MERGE = "Approve & merge";
export const REQUEST_CHANGES = "Request changes";
export const MERGE_OPTIONS = [APPROVE_MERGE, REQUEST_CHANGES] as const;

export const ApprovesArg = Type.Optional(
  Type.Array(Type.String({ minLength: 1 }), {
    description:
      "Only on a card's open merge question: which of your options approve the merge, each one of options. The captain picking one approves it. Required when you rewrite its options: [] when none approves. His own words and any other option come to you to judge",
  }),
);

export const RetireReason = Type.String({
  pattern: "\\S",
  description:
    "With supersededBy, on clear: why the hold no longer matters. It is not a decision and never approves anything",
});
export const SupersededBy = Type.Union(
  [Type.Integer({ minimum: 1 }), Type.String({ pattern: PR_PATTERN })],
  {
    description:
      "The card number or the full PR URL that replaced the gated action. A card must exist, differ from this one, and not be dropped. A PR must be recorded on another card",
  },
);
export const RetireArg = Type.Object({ reason: RetireReason, supersededBy: SupersededBy });

type Fields = Readonly<Record<string, unknown>>;

const stringsOf = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : []);

export function approvesOf(fields: Fields): string[] {
  const options = stringsOf(fields["options"]);
  const legacy = fields["merge"] === true ? [APPROVE_MERGE] : [];
  const named = fields["approves"];
  return stringsOf(Array.isArray(named) ? named : legacy).filter((option) =>
    options.includes(option),
  );
}

export function approvedBy(fields: Fields): boolean {
  const approved = fields["approved"];
  return typeof approved === "boolean" ? approved : fields["choice"] === APPROVE_MERGE;
}
