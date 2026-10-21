import {
  MERGE_OPTIONS,
  type Activity,
  type Board,
  type BoardCard,
  type Entry,
  type Status,
} from "@fleet/protocol";
import type { Glyph } from "./icons.tsx";

export type Question = Board["holds"][number];
type Column = "up-next" | "progress" | "needs" | "merging" | "done" | "dropped" | "mates";

const recentFirst = (a: BoardCard, b: BoardCard): number => b.updatedAt - a.updatedAt;

export function questionsByCard(questions: readonly Question[]): Map<number, Question> {
  return new Map(questions.map((question) => [question.card, question]));
}

const COLUMNS: Readonly<Record<Status, Column>> = {
  queued: "up-next",
  waiting: "up-next",
  working: "progress",
  paused: "progress",
  "in-review": "progress",
  "with-mate": "progress",
  "needs-you": "needs",
  merging: "merging",
  done: "done",
  dropped: "dropped",
};

function columnOf(card: BoardCard, asked: boolean): Column {
  if (card.mate) return "mates";
  return asked ? "needs" : COLUMNS[card.status];
}

export interface Columns {
  readonly queued: readonly BoardCard[];
  readonly later: readonly BoardCard[];
  readonly progress: readonly BoardCard[];
  readonly needs: readonly BoardCard[];
  readonly merging: readonly BoardCard[];
  readonly today: readonly BoardCard[];
  readonly older: readonly BoardCard[];
  readonly dropped: readonly BoardCard[];
  readonly mates: readonly BoardCard[];
}

export const startOfDay = (now: number): number => new Date(now).setHours(0, 0, 0, 0);

export function arrange(
  cards: readonly BoardCard[],
  asked: ReadonlyMap<number, Question>,
  now: number,
): Columns {
  const inColumn = (column: Column): BoardCard[] =>
    cards.filter((card) => columnOf(card, asked.has(card.id)) === column);
  const order = [...asked.keys()];
  const done = inColumn("done").sort(recentFirst);
  const upNext = inColumn("up-next");
  return {
    queued: upNext.filter((card) => card.status === "queued").sort((a, b) => a.id - b.id),
    later: upNext.filter((card) => card.status === "waiting").sort(recentFirst),
    progress: inColumn("progress").sort(recentFirst),
    needs: inColumn("needs").sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id)),
    merging: inColumn("merging").sort(recentFirst),
    today: done.filter((card) => card.updatedAt >= startOfDay(now)),
    older: done.filter((card) => card.updatedAt < startOfDay(now)),
    dropped: inColumn("dropped").sort(recentFirst),
    mates: inColumn("mates").sort((a, b) => a.lane.localeCompare(b.lane)),
  };
}

const NO_PROJECT = "No project";

export interface Swimlane {
  readonly project: string;
  readonly columns: Columns;
  readonly needs: number;
}

export function swimlanes(
  cards: readonly BoardCard[],
  asked: ReadonlyMap<number, Question>,
  now: number,
): Swimlane[] {
  const projects = [
    ...new Set(cards.filter((card) => !card.mate).map((card) => card.project ?? NO_PROJECT)),
  ];
  return projects
    .map((project) => {
      const own = cards.filter((card) => !card.mate && (card.project ?? NO_PROJECT) === project);
      const columns = arrange(own, asked, now);
      return { project, columns, needs: columns.needs.length };
    })
    .filter(({ columns: each }) =>
      [each.queued, each.later, each.progress, each.needs, each.merging, each.today].some(
        (column) => column.length > 0,
      ),
    )
    .sort(
      (a, b) =>
        Number(b.needs > 0) - Number(a.needs > 0) ||
        Number(a.project === NO_PROJECT) - Number(b.project === NO_PROJECT) ||
        a.project.localeCompare(b.project),
    );
}

export const openIn = (lane: Swimlane): number => {
  const { columns } = lane;
  return (
    columns.queued.length +
    columns.later.length +
    columns.progress.length +
    columns.needs.length +
    columns.merging.length
  );
};

export interface Live {
  readonly text: string;
  readonly tone: "running" | "quiet" | "lost";
}

export function liveOf(activity: Activity, now: number): Live {
  const quiet = age(activity.at, now);
  if (activity.state === "running")
    return quiet === "now"
      ? { text: "running", tone: "running" }
      : { text: `running · quiet ${quiet}`, tone: "running" };
  if (activity.state === "waiting") return { text: "waiting on a job", tone: "quiet" };
  if (activity.state === "starting") return { text: "starting", tone: "quiet" };
  if (activity.state === "idle")
    return { text: quiet === "now" ? "idle" : `idle ${quiet}`, tone: "quiet" };
  return { text: quiet === "now" ? "disconnected" : `disconnected ${quiet}`, tone: "lost" };
}

const GLYPHS: Readonly<Record<Status, Glyph>> = {
  queued: "queued",
  waiting: "later",
  working: "working",
  paused: "working",
  "in-review": "review",
  "with-mate": "mate",
  "needs-you": "needs",
  merging: "merging",
  done: "done",
  dropped: "dropped",
};

export const glyphOf = (card: BoardCard, asked: boolean): Glyph =>
  asked ? "needs" : GLYPHS[card.status];

export function needsFacts(card: BoardCard, today: number): boolean {
  if (card.mate) return false;
  if (card.status === "waiting") return true;
  const landing = card.kind === "ship" && (card.status === "merging" || card.status === "done");
  return landing && (card.status === "merging" || card.updatedAt >= today);
}

export interface Facts {
  readonly until: number | undefined;
  readonly approval: "you" | "automatic" | "other";
}

export function factsOf(entries: readonly Entry[]): Facts {
  const until = entries.findLast(
    (entry) => entry.kind === "hold" && typeof entry.fields["until"] === "number",
  )?.fields["until"];
  const approved = entries.some(
    (entry) => entry.kind === "answer" && entry.fields["choice"] === MERGE_OPTIONS[0],
  );
  const asked = entries.some((entry) => entry.kind === "hold" && entry.fields["merge"] === true);
  return {
    until: typeof until === "number" ? until : undefined,
    approval: approved ? "you" : asked ? "other" : "automatic",
  };
}

export const prLabel = (url: string): string => {
  const match = /^https:\/\/[^/]+\/[^/]+\/([^/]+)\/pull\/(\d+)/.exec(url);
  return match === null ? url.replace(/^https:\/\//, "") : `${match[1] ?? ""}#${match[2] ?? ""}`;
};

const landing = (card: BoardCard): string => (card.delivery === "local-only" ? "Landed" : "Merged");

export function doneLabel(card: BoardCard, facts: Facts | undefined): string {
  if (card.status === "dropped") return "Dropped";
  if (card.kind !== "ship" || (card.pr === null && card.delivery !== "local-only")) return "Done";
  return facts?.approval === "automatic" ? `${landing(card)} automatically` : landing(card);
}

export function mergingLabel(facts: Facts | undefined): string {
  if (facts?.approval === "you") return "you approved · landing";
  return facts?.approval === "automatic" ? "merging automatically" : "landing";
}

const DAY = 86_400_000;

export function laterLabel(until: number, now: number): string {
  const at = new Date(until);
  const time = at.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  if (new Date(now).toDateString() === at.toDateString()) return time;
  if (until - now < 6 * DAY)
    return `${at.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
  return at.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function age(from: number, now: number): string {
  const minutes = Math.floor((now - from) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${String(minutes)}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)}h`;
  return `${String(Math.floor(hours / 24))}d`;
}

const LANE_COLORS = ["#c2410c", "#0e7490", "#9d174d", "#4d7c0f", "#a16207", "#1d4ed8", "#be123c"];

export function laneColor(lane: string): string {
  if (lane === "main") return "#6d5bd0";
  let hash = 0;
  for (const char of lane) hash = (hash * 31 + char.charCodeAt(0)) % 997;
  return LANE_COLORS[hash % LANE_COLORS.length] ?? "#52525b";
}

export function lanesOf(cards: readonly BoardCard[]): string[] {
  const lanes = [...new Set(cards.map((card) => card.lane))];
  return lanes.sort((a, b) => (a === "main" ? -1 : b === "main" ? 1 : a.localeCompare(b)));
}

const PHRASES: Record<Status, string> = {
  queued: "Queued",
  working: "Working",
  "in-review": "In review",
  paused: "Paused",
  "with-mate": "With its mate",
  "needs-you": "Waiting for you",
  merging: "Merging",
  waiting: "On hold",
  done: "Done",
  dropped: "Dropped",
};

export function since(from: number, now: number): string {
  const minutes = Math.floor((now - from) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${String(minutes)}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)}h ago`;
  return `${String(Math.floor(hours / 24))}d ago`;
}

export const withWho = (card: BoardCard): string => (card.holder === "main" ? "main" : card.lane);

export function phraseOf(card: BoardCard, asked: boolean): string {
  if (card.mate) return "Second mate";
  const phrase = asked && card.status !== "needs-you" ? PHRASES["needs-you"] : PHRASES[card.status];
  return card.status === "with-mate" ? `With ${withWho(card)}` : phrase;
}

export const firstLine = (text: string): string =>
  text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line !== "") ?? "";

function rest(text: string): string {
  const lines = text.trim().split("\n");
  const first = lines.findIndex((line) => line.trim() !== "");
  return lines
    .slice(first + 1)
    .join("\n")
    .trim();
}

export const bodyOf = (entry: Entry): string =>
  entry.fields["routed"] === true ? rest(entry.body) : entry.body;

type Role = "captain" | "first-mate" | "mate" | "worker" | "fleet";

export interface Author {
  readonly name: string;
  readonly role: Role;
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

function commentVerb(entry: Entry): string {
  if (entry.fields["task"] === true) return "sent the task";
  return typeof entry.fields["resolves"] === "string" ? "decided" : "";
}

const holdVerb = (entry: Entry): string =>
  entry.fields["escalated"] === true ? "escalated it" : "asked";

export function verb(entry: Entry): string {
  const status = entry.fields["status"];
  if (entry.kind === "comment") return commentVerb(entry);
  if (entry.kind === "report" && typeof status === "string") return REPORTS[status] ?? status;
  if (entry.fields["routed"] === true) return "sent it here";
  if (entry.kind === "cleanup")
    return entry.fields["outcome"] === "dropped" ? "dropped it" : "closed it";
  return entry.kind === "hold" ? holdVerb(entry) : (VERBS[entry.kind] ?? "");
}

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

export function keyOf(entry: Entry): string | undefined {
  const field = entry.kind === "report" ? "key" : entry.kind === "comment" ? "resolves" : undefined;
  const key = field === undefined ? undefined : entry.fields[field];
  return typeof key === "string" ? key : undefined;
}
