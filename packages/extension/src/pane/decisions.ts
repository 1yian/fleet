import { laterLine, type BoardCard, type CardView } from "@fleet/protocol";
import type { Link } from "../link.ts";

const DEADLINE_MS = 10_000;

export interface Decision {
  readonly card: number;
  readonly title: string;
  readonly hold: number;
  readonly question: string;
  readonly options: readonly string[];
}

const needsYou = (card: BoardCard): boolean => card.status === "needs-you";

function decisionOf({ card, hold }: CardView): Decision[] {
  if (!needsYou(card) || hold?.holder !== "captain") return [];
  const { entry, question, options } = hold;
  return [{ card: card.id, title: card.title, hold: entry, question, options }];
}

export async function decisionsOf(link: Link, cards: readonly BoardCard[]): Promise<Decision[]> {
  const waiting = cards.filter(needsYou).sort((a, b) => a.updatedAt - b.updatedAt);
  const views = await Promise.all(
    waiting.map((card) => link.call("card", { card: card.id }, DEADLINE_MS)),
  );
  return views.flatMap(decisionOf);
}

export async function deferDecision(link: Link, decision: Decision, said: string): Promise<string> {
  const { card, hold } = decision;
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const later = await link.call("pane.later", { card, hold, said, zone }, DEADLINE_MS);
  return laterLine(card, later, Date.now());
}

export async function answerDecision(
  link: Link,
  decision: Decision,
  choice: string,
  written: boolean,
): Promise<void> {
  const { card, hold } = decision;
  await link.call(
    "pane.answer",
    { card, hold, choice, ...(written ? { written } : {}) },
    DEADLINE_MS,
  );
}
