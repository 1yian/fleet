// How the board words a card and its updates for the captain. Pure functions only.
import type { Board, BoardCard, Entry, Status } from "@fleet/protocol";

/** A hold that waits on the captain: all its questions in one text, and the options that answer it. */
export type Question = Board["holds"][number];
export type Tone = "needs" | "running" | "done" | "dropped" | "mate";

/** The Done group shows the most recent cards only. */
const DONE_SHOWN = 20;

const closed = (card: BoardCard): boolean => card.status === "done" || card.status === "dropped";
const recentFirst = (a: BoardCard, b: BoardCard): number => b.updatedAt - a.updatedAt;

/** Each card's open questions, in board order. */
export function questionsByCard(questions: readonly Question[]): Map<number, Question[]> {
  const byCard = new Map<number, Question[]>();
  for (const question of questions) {
    byCard.set(question.card, [...(byCard.get(question.card) ?? []), question]);
  }
  return byCard;
}

/**
 * The inbox's groups. A card with a question for the captain needs them, whatever
 * its status, and the card of the first question comes first. The lane cards of the
 * second mates are not work: they are the Mates group, the talk between main and each mate.
 */
export function groups(
  cards: readonly BoardCard[],
  asked: ReadonlyMap<number, Question[]>,
): Record<"needs" | "running" | "done" | "mates", BoardCard[]> {
  const order = [...asked.keys()];
  const rank = (card: BoardCard): number => {
    const index = order.indexOf(card.id);
    return index === -1 ? order.length : index;
  };
  const work = cards.filter((card) => !card.mate);
  const needs = work
    .filter((card) => asked.has(card.id) || card.status === "needs-you")
    .sort((a, b) => rank(a) - rank(b));
  const rest = work.filter((card) => !needs.includes(card));
  return {
    needs,
    mates: cards.filter((card) => card.mate).sort((a, b) => a.lane.localeCompare(b.lane)),
    running: rest.filter((card) => !closed(card)).sort(recentFirst),
    done: rest.filter(closed).sort(recentFirst).slice(0, DONE_SHOWN),
  };
}

export function toneOf(card: BoardCard, asked: boolean): Tone {
  if (card.mate) return "mate";
  if (asked || card.status === "needs-you") return "needs";
  if (card.status === "done") return "done";
  if (card.status === "dropped") return "dropped";
  return "running";
}

/** Whether work on the card is under way right now, not waiting to start or on someone. */
export const isActive = (card: BoardCard): boolean =>
  card.status === "working" || card.status === "in-review" || card.status === "merging";

const PHRASES: Record<Status, string> = {
  queued: "Queued",
  working: "Working",
  "in-review": "In review",
  "with-mate": "With its mate",
  "needs-you": "Waiting for you",
  merging: "Merging",
  waiting: "On hold",
  done: "Done",
  dropped: "Dropped",
};

/** A short time since a moment: "just now", "5m ago", "3h ago", "2d ago". */
export function since(from: number, now: number): string {
  const minutes = Math.floor((now - from) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${String(minutes)}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)}h ago`;
  return `${String(Math.floor(hours / 24))}d ago`;
}

/** The mate that must act on a card with its mate: main when its hold waits on main, otherwise the card's own mate. */
const withWho = (card: BoardCard): string => (card.holder === "main" ? "main" : card.lane);

/** Where the card stands, such as "In review" or "With cleo". A waiting hold outranks the status. */
export function phraseOf(card: BoardCard, asked: boolean): string {
  if (card.mate) return "Second mate";
  const phrase = asked && card.status !== "needs-you" ? PHRASES["needs-you"] : PHRASES[card.status];
  return card.status === "with-mate" ? `With ${withWho(card)}` : phrase;
}

export const statusLine = (card: BoardCard, asked: boolean, now: number): string =>
  `${phraseOf(card, asked)} · ${since(card.updatedAt, now)}`;

export const firstLine = (text: string): string =>
  text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line !== "") ?? "";

/** Everything after the first line, for an update that opens to its details. */
function rest(text: string): string {
  const lines = text.trim().split("\n");
  const first = lines.findIndex((line) => line.trim() !== "");
  return lines
    .slice(first + 1)
    .join("\n")
    .trim();
}

/** An update's text as the captain reads it. A routing note leads with the card's title, which the card already shows. */
export const bodyOf = (entry: Entry): string =>
  entry.fields["routed"] === true ? rest(entry.body) : entry.body;

type Role = "captain" | "first-mate" | "mate" | "worker" | "fleet";

/** Who wrote an entry: the name the captain reads, and the part they play. */
export interface Author {
  readonly name: string;
  readonly role: Role;
  /** A short tag after the name for the mates, so the lane mate and main are told apart. */
  readonly tag: string;
}

export function authorOf(author: string): Author {
  if (author === "captain") return { name: "You", role: "captain", tag: "" };
  if (author === "mate:main") return { name: "main", role: "first-mate", tag: "First mate" };
  if (author.startsWith("mate:"))
    return { name: author.slice("mate:".length), role: "mate", tag: "Mate" };
  if (author.startsWith("worker:")) return { name: "Worker", role: "worker", tag: "" };
  return { name: author.charAt(0).toUpperCase() + author.slice(1), role: "fleet", tag: "" };
}

/** A worker's report status after "Worker". Progress needs no word. */
const REPORTS: Readonly<Record<string, string>> = {
  working: "",
  note: "",
  "in-review": "is validating",
  "needs-decision": "needs a decision",
  done: "is done",
  paused: "paused",
};

const VERBS: Readonly<Record<string, string>> = {
  release: "decided",
  answer: "answered",
  grant: "granted",
  finding: "noticed",
};

/** What a mate's comment did: sent the task, or decided what a worker asked. */
function commentVerb(entry: Entry): string {
  if (entry.fields["task"] === true) return "sent the task";
  return typeof entry.fields["resolves"] === "string" ? "decided" : "";
}

/** A hold is a question, or an escalation of the question that a mate held. */
const holdVerb = (entry: Entry): string =>
  entry.fields["escalated"] === true ? "escalated it" : "asked";

/** What an update did, such as "asked" or a worker's report status, after its author. */
export function verb(entry: Entry): string {
  const status = entry.fields["status"];
  if (entry.kind === "comment") return commentVerb(entry);
  if (entry.kind === "report" && typeof status === "string") return REPORTS[status] ?? status;
  if (entry.fields["routed"] === true) return "sent it here";
  if (entry.kind === "cleanup")
    return entry.fields["outcome"] === "dropped" ? "dropped it" : "closed it";
  return entry.kind === "hold" ? holdVerb(entry) : (VERBS[entry.kind] ?? "");
}

/** An entry is a message (said to the captain or by him) or an event (something that happened). */
const MESSAGES: ReadonlySet<string> = new Set([
  "comment",
  "hold",
  "release",
  "answer",
  "report",
  "note",
]);
export const isMessage = (entry: Entry): boolean =>
  MESSAGES.has(entry.kind) && entry.fields["routed"] !== true && entry.fields["task"] !== true;

/** The decision key an entry carries: what a mate's decision resolves, or what a worker asks to have decided. */
export function keyOf(entry: Entry): string | undefined {
  const field = entry.kind === "report" ? "key" : entry.kind === "comment" ? "resolves" : undefined;
  const key = field === undefined ? undefined : entry.fields[field];
  return typeof key === "string" ? key : undefined;
}
