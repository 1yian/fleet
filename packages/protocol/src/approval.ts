import Type from "typebox";

export const APPROVE_MERGE = "Approve & merge";

export const ApprovesArg = Type.Optional(
  Type.Array(Type.String({ minLength: 1 }), {
    description:
      "Only on a card's open merge question: which of your options approve the merge, each one of options. The captain picking one approves it. Required when you rewrite its options: [] when none approves. His own words and any other option come to you to judge",
  }),
);

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
