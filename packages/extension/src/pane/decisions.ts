import type { CardView } from "@fleet/protocol";
import type { Link } from "../link.ts";

const DEADLINE_MS = 10_000;

export interface Decision {
  readonly card: number;
  readonly title: string;
  readonly revision: number;
  readonly question: string;
  readonly options: readonly string[];
}

function decisionOf({ card, hold }: CardView): Decision[] {
  if (hold?.holder !== "captain") return [];
  const { question, options } = hold;
  return [{ card: card.id, title: card.title, revision: card.revision, question, options }];
}

export async function loadDecisions(link: Link): Promise<Decision[]> {
  const cards = await link.call("board", {}, DEADLINE_MS);
  const waiting = cards
    .filter((card) => card.status === "needs-you")
    .sort((a, b) => a.updatedAt - b.updatedAt);
  const views = await Promise.all(
    waiting.map((card) => link.call("card", { card: card.id }, DEADLINE_MS)),
  );
  return views.flatMap(decisionOf);
}

export async function answerDecision(
  link: Link,
  decision: Decision,
  choice: string,
  written: boolean,
): Promise<void> {
  const { card, revision } = decision;
  await link.call(
    "pane.answer",
    { card, revision, choice, ...(written ? { written } : {}) },
    DEADLINE_MS,
  );
}
