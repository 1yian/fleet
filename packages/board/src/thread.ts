import type { Entry } from "@fleet/protocol";
import { bodyOf } from "./format.ts";

const MAIN = "main";
const YOU = "You";
const WORKER = "worker";
const MIN_QUOTE = 12;
const ECHO = "(your words above)";

export interface Flow {
  readonly from: string;
  readonly to: string;
}

export interface Row {
  readonly entry: Entry;
  readonly flow: Flow | undefined;
  readonly quiet: boolean;
  readonly text: string;
  readonly replyTo: Entry | undefined;
  readonly asker: string | undefined;
}

interface Where {
  readonly lane: string;
}

function party(author: string): string {
  if (author === "captain") return YOU;
  if (author.startsWith("mate:")) return author.slice("mate:".length);
  if (author.startsWith("worker:")) return WORKER;
  return author.charAt(0).toUpperCase() + author.slice(1);
}

const text = (entry: Entry, key: string): string | undefined => {
  const value = entry.fields[key];
  return typeof value === "string" ? value : undefined;
};

function captainTo(entry: Entry, where: Where): string {
  if (entry.kind === "answer" && text(entry, "by") === "board")
    return where.lane === MAIN ? MAIN : `${where.lane}, ${MAIN}`;
  if (entry.kind === "answer") return where.lane === MAIN ? MAIN : where.lane;
  if (
    entry.kind === "comment" &&
    text(entry, "lane") === undefined &&
    text(entry, "owes") === undefined &&
    where.lane !== MAIN
  )
    return where.lane;
  return MAIN;
}

function commentTo(entry: Entry, where: Where): string {
  if (text(entry, "replyTo") !== undefined)
    return entry.author === `mate:${MAIN}` ? where.lane : MAIN;
  const target = text(entry, "for");
  if (target === "mate") return where.lane;
  return target === MAIN ? MAIN : WORKER;
}

function holdTo(entry: Entry, where: Where): string | undefined {
  const holder = text(entry, "holder");
  if (holder === "captain") return YOU;
  if (holder === MAIN) return MAIN;
  return entry.author === `mate:${where.lane}` ? undefined : where.lane;
}

function toOf(entry: Entry, where: Where): string | undefined {
  if (entry.author === "captain") return captainTo(entry, where);
  if (entry.author.startsWith("worker:")) return where.lane;
  if (entry.kind === "comment") return commentTo(entry, where);
  if (entry.kind === "hold") return holdTo(entry, where);
  if (entry.kind === "release" && entry.author === `mate:${MAIN}` && where.lane !== MAIN)
    return where.lane;
  return undefined;
}

function flowOf(entry: Entry, where: Where): Flow | undefined {
  const to = toOf(entry, where);
  return to === undefined ? undefined : { from: party(entry.author), to };
}

const isAgent = (name: string): boolean => name !== YOU && name !== WORKER;

const quietFlow = (entry: Entry, flow: Flow | undefined): boolean =>
  flow !== undefined && entry.author.startsWith("mate:") && isAgent(flow.to);

const words = (entry: Entry): string => entry.body.trim();

const isRepeat = (entry: Entry, before: readonly Entry[]): boolean =>
  entry.kind === "answer" &&
  text(entry, "by") !== "board" &&
  before.some(
    (earlier) =>
      earlier.author === "captain" && words(earlier) === words(entry) && earlier.id < entry.id,
  );

function withoutQuotes(body: string, said: readonly string[]): string {
  return said.reduce((rest, quote) => {
    const quoted = new RegExp(`["“']${escaped(quote)}["”']`, "g");
    return rest.replace(quoted, ECHO).replaceAll(quote, ECHO);
  }, body);
}

const escaped = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function askerOf(entry: Entry, before: readonly Entry[]): string | undefined {
  if (
    entry.kind !== "hold" ||
    entry.fields["escalated"] !== true ||
    text(entry, "holder") !== "captain"
  )
    return undefined;
  const wrote = before.findLast(
    (earlier) => earlier.kind === "hold" && earlier.author !== entry.author,
  );
  return wrote === undefined ? undefined : party(wrote.author);
}

export function threadRows(entries: readonly Entry[], where: Where): Row[] {
  const shown = entries.filter((entry, i) => !isRepeat(entry, entries.slice(0, i)));
  return shown.map((entry, i) => {
    const before = shown.slice(0, i);
    const said = before
      .filter((earlier) => earlier.author === "captain" && words(earlier).length >= MIN_QUOTE)
      .map(words)
      .toSorted((a, b) => b.length - a.length);
    const reply = text(entry, "replyTo");
    const id = reply === undefined ? undefined : /^r-(\d+)$/.exec(reply)?.[1];
    const replyTo = id === undefined ? undefined : before.find((each) => each.id === Number(id));
    const directed = flowOf(entry, where);
    const flow =
      replyTo === undefined ? directed : { from: party(entry.author), to: party(replyTo.author) };
    return {
      entry,
      flow,
      quiet: quietFlow(entry, flow),
      text: entry.author === "captain" ? bodyOf(entry) : withoutQuotes(bodyOf(entry), said),
      replyTo,
      asker: askerOf(entry, before),
    };
  });
}
