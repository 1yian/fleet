import type { BoardCard, CardView, Entry, Status } from "@fleet/protocol";
import { encode } from "@toon-format/toon";

const ORDER = [
  "needs-you",
  "with-mate",
  "merging",
  "in-review",
  "working",
  "queued",
  "waiting",
  "done",
  "dropped",
] as const satisfies readonly Status[];
const MOVER: Record<Status, "lane" | "worker" | "merge" | "nobody"> = {
  "needs-you": "lane",
  "with-mate": "lane",
  merging: "merge",
  "in-review": "worker",
  working: "worker",
  queued: "lane",
  waiting: "lane",
  done: "nobody",
  dropped: "nobody",
};
const rank = (card: BoardCard): number => ORDER.indexOf(card.status);
const isClosed = (card: BoardCard): boolean => MOVER[card.status] === "nobody";

export const SELECTIONS = ["open", "closed", "all", ...ORDER] as const;
type Selection = (typeof SELECTIONS)[number];

function waits(card: BoardCard): string {
  if (card.holder === "captain" || card.holder === "main") return card.holder;
  const mover = card.holder === "owner" ? "lane" : MOVER[card.status];
  return mover === "lane" ? card.lane : mover;
}

function ago(at: number, now = Date.now()): string {
  const seconds = Math.round(Math.abs(now - at) / 1000);
  const [value, unit] =
    seconds < 60
      ? [seconds, "s"]
      : seconds < 3600
        ? [Math.floor(seconds / 60), "m"]
        : seconds < 86_400
          ? [Math.floor(seconds / 3600), "h"]
          : [Math.floor(seconds / 86_400), "d"];
  return at > now ? `in ${String(value)}${unit}` : `${String(value)}${unit} ago`;
}

function cut(text: string, max: number, full: boolean): string {
  if (full || text.length <= max) return text;
  return `${text.slice(0, max).trimEnd()}... (truncated, ${String(text.length)} chars total, full=true shows all)`;
}

const deliveryOf = (card: BoardCard): string => {
  if (card.delivery !== null) return card.delivery;
  return card.kind === "scout" ? "report" : "none";
};

const COLUMNS = {
  card: (card: BoardCard) => card.id,
  status: (card: BoardCard) => card.status,
  waits,
  delivery: deliveryOf,
  title: (card: BoardCard) => card.title,
  name: (card: BoardCard) => card.name,
  lane: (card: BoardCard) => card.lane,
  kind: (card: BoardCard) => card.kind,
  project: (card: BoardCard) => card.project ?? "",
  pr: (card: BoardCard) => card.pr ?? "",
  summary: (card: BoardCard) => cut(card.summary, 120, false),
  updated: (card: BoardCard) => ago(card.updatedAt),
} as const;
type Column = keyof typeof COLUMNS;
const DEFAULT_COLUMNS = ["card", "status", "waits", "delivery", "title"] as const;
const isColumn = (name: string): name is Column => Object.hasOwn(COLUMNS, name);
const isDefault = (name: string): boolean => DEFAULT_COLUMNS.some((each) => each === name);
export const EXTRA_COLUMNS = Object.keys(COLUMNS).filter((each) => !isDefault(each));

const helpLines = (lines: readonly string[]): string =>
  lines.length === 0
    ? ""
    : `\nhelp[${String(lines.length)}]:\n${lines.map((line) => `  ${line}`).join("\n")}`;

export const errorText = (message: string, help: readonly string[]): string =>
  encode({ error: message }) + helpLines(help);

function tally(cards: readonly BoardCard[]): string | number {
  const parts = ORDER.flatMap((status) => {
    const n = cards.filter((card) => card.status === status).length;
    return n === 0 ? [] : [`${status} ${String(n)}`];
  });
  return parts.length === 0 ? 0 : `${String(cards.length)} (${parts.join(", ")})`;
}

function columnsOf(fields: string | undefined): Column[] {
  const asked = (fields ?? "")
    .split(",")
    .map((each) => each.trim())
    .filter((each) => each !== "");
  const unknown = asked.filter((each) => !isColumn(each));
  if (unknown.length > 0) {
    const fix = `Call \`board(fields=<fields>)\` with fields from: ${EXTRA_COLUMNS.join(", ")}`;
    throw new Error(errorText(`unknown field ${unknown.join(", ")}`, [fix]));
  }
  return [...DEFAULT_COLUMNS, ...asked.filter(isColumn).filter((each) => !isDefault(each))];
}

export interface BoardQuery {
  readonly status?: Selection;
  readonly projects?: boolean;
  readonly lanes?: boolean;
  readonly lane?: string;
  readonly limit?: number;
  readonly fields?: string;
}

const CLOSED_LIMIT = 10;

const selects = (selection: Selection, card: BoardCard): boolean => {
  if (selection === "open") return !isClosed(card);
  if (selection === "closed") return isClosed(card);
  return selection === "all" || card.status === selection;
};

const byAttention = (a: BoardCard, b: BoardCard): number =>
  rank(a) - rank(b) || b.updatedAt - a.updatedAt;

function rowsOf(cards: readonly BoardCard[], selection: Selection, limit: number) {
  const matched = cards.filter((card) => selects(selection, card)).sort(byAttention);
  const open = matched.filter((card) => !isClosed(card));
  const closed = matched.filter(isClosed).sort((a, b) => b.updatedAt - a.updatedAt);
  return { rows: [...open, ...closed.slice(0, limit)], hidden: Math.max(0, closed.length - limit) };
}

export function boardText(all: readonly BoardCard[], query: BoardQuery, header: Header): string {
  const columns = columnsOf(query.fields);
  const selection = query.status ?? "open";
  const lane = query.lane;
  const cards = lane === undefined ? all : all.filter((card) => card.lane === lane);
  const { rows, hidden } = rowsOf(cards, selection, query.limit ?? CLOSED_LIMIT);
  const closed = cards.filter(isClosed);

  const open = all.filter((card) => !isClosed(card));
  const top = headerOf(header, open, query);
  const record: Record<string, unknown> = {
    ...top.record,
    ...(lane === undefined ? {} : { lane }),
  };
  record["open"] = tally(cards.filter((card) => !isClosed(card)));
  record["closed"] = tally(closed);
  if (hidden > 0) record["hidden"] = `${String(hidden)} older closed cards`;
  const what = `${selection === "all" ? "" : `${selection} `}cards${lane === undefined ? "" : ` in lane ${lane}`}`;
  record["cards"] =
    rows.length === 0
      ? `0 ${what}`
      : rows.map((card) => Object.fromEntries(columns.map((each) => [each, COLUMNS[each](card)])));
  return (
    encode(record) +
    helpLines([...top.help, ...boardHelp(query, rows.length, closed.length, hidden)])
  );
}

function boardHelp(query: BoardQuery, rows: number, closed: number, hidden: number): string[] {
  const help: string[] = [];
  if (rows > 0)
    help.push("Call `board(card=<card>)` to read a card: its hold, PR, branch, and thread");
  if ((query.status ?? "open") === "open" && closed > 0)
    help.push('Call `board(status="closed")` to list the newest closed cards');
  if (hidden > 0)
    help.push(
      `Call \`board(status="${query.status ?? "open"}", limit=<n>)\` to list more closed cards`,
    );
  if (rows > 0 && query.fields === undefined)
    help.push(`Call \`board(fields="lane,pr")\` for more columns: ${EXTRA_COLUMNS.join(", ")}`);
  return help;
}

export interface CardQuery {
  readonly entries?: number;
  readonly full?: boolean;
}

const ENTRY_LIMIT = 10;

function kindOf(entry: Entry): string {
  const detail = entry.fields[entry.kind === "hold" ? "holder" : "status"];
  return typeof detail === "string" && detail !== "" ? `${entry.kind}/${detail}` : entry.kind;
}

function reportPath(entries: readonly Entry[]): string | undefined {
  for (const entry of [...entries].reverse()) {
    if (entry.kind !== "report") continue;
    const found = /report written:\s*(\S+?)[.,;:]?(?=\s|$)/i.exec(entry.body);
    if (found?.[1] !== undefined) return found[1];
  }
  return undefined;
}

type Cut = (text: string, max: number) => string;

const firstLineOf = (text: string): string =>
  text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line !== "") ?? "";

function about({ card, hold }: CardView, clip: Cut): Record<string, unknown> {
  const record: Record<string, unknown> = {
    card: {
      id: card.id,
      name: card.name,
      title: card.title,
      kind: card.kind,
      project: card.project ?? "none",
      delivery: deliveryOf(card),
      lane: card.lane,
      status: card.status,
      waits: waits(card),
      pr: card.pr ?? "none",
      updated: ago(card.updatedAt),
    },
  };
  if (card.replies.length > 0)
    record["replies"] = card.replies.map((each) => ({
      id: each.id,
      from: each.from,
      owes: each.owes,
      asked: ago(each.askedAt),
      resent: each.resentAt === null ? "no" : ago(each.resentAt),
      escalated: each.escalatedAt === null ? "no" : ago(each.escalatedAt),
      text: clip(firstLineOf(each.text), 160),
    }));
  if (hold === null) return record;
  record["hold"] = {
    waits: hold.holder === "owner" ? card.lane : hold.holder,
    question: clip(hold.question, 600),
    options: hold.options,
    ...(hold.until === null ? {} : { until: ago(hold.until) }),
  };
  return record;
}

export function cardText(view: CardView, query: CardQuery): string {
  const full = query.full === true;
  const cuts = { made: false };
  const clip: Cut = (text, max) => {
    cuts.made ||= !full && text.length > max;
    return cut(text, max, full);
  };
  const { card } = view;
  const record = about(view, clip);
  record["attempts"] = view.attempts.length === 0 ? "0 (never dispatched)" : view.attempts;
  const report = reportPath(view.entries);
  if (report !== undefined) record["report"] = report;
  if (card.intent !== "") record["intent"] = clip(card.intent, 300);
  if (card.spec !== "") record["spec"] = clip(card.spec, 300);
  const total = view.entries.length;
  const shown = view.entries.toReversed().slice(0, query.entries ?? ENTRY_LIMIT);
  if (shown.length < total) record["hidden"] = `${String(total - shown.length)} older entries`;
  record["entries"] =
    total === 0
      ? "0 entries"
      : shown.map((entry) => ({
          id: entry.id,
          age: ago(entry.createdAt),
          from: entry.author,
          kind: kindOf(entry),
          body: clip(entry.body, 240),
        }));
  const help = cardHelp(card, total > shown.length ? total : 0, cuts.made);
  return encode(record) + helpLines(help);
}

function cardHelp(card: BoardCard, thread: number, clipped: boolean): string[] {
  const id = String(card.id);
  const help: string[] = [];
  if (thread > 0)
    help.push(`Call \`board(card=${id}, entries=${String(thread)})\` to read the whole thread`);
  if (clipped) help.push(`Call \`board(card=${id}, full=true)\` to see every text whole`);
  if (!isClosed(card)) help.push(`Call \`comment(card=${id}, text=<text>)\` to steer the card`);
  if (card.replies.length > 0)
    help.push(
      `An owed reply clears when its owner answers with replyTo=<id>, or when its asker calls \`comment(card=${id}, text, withdraws=<id>)\``,
    );
  return help;
}

interface ProjectRow {
  readonly name: string;
  readonly delivery: string;
  readonly base: string;
  readonly clones: readonly { host: string }[];
  readonly yolo: boolean;
}

export interface LaneRow {
  readonly lane: string;
  readonly host: string;
  readonly state: string;
  readonly detail: string;
}

export interface Header {
  readonly projects: readonly ProjectRow[];
  readonly lanes?: {
    readonly lanes: readonly LaneRow[];
    readonly unreachable: readonly { host: string; error: string }[];
  };
}

const HEADER_PROJECTS = 8;

function projectsOf(
  projects: readonly ProjectRow[],
  open: readonly BoardCard[],
  every: boolean,
): { rows: Record<string, unknown>[] | string; hidden: number } {
  if (projects.length === 0) return { rows: "0 registered", hidden: 0 };
  const used = new Set(open.map((card) => card.project));
  const shown =
    every || projects.length <= HEADER_PROJECTS
      ? projects
      : projects.filter((each) => each.yolo || used.has(each.name));
  const rows = shown.map((each) => ({
    name: each.name,
    delivery: each.delivery,
    ...(every ? { base: each.base } : {}),
    hosts: each.clones.map((clone) => clone.host).join(" "),
    yolo: each.yolo ? "on" : "off",
  }));
  return { rows, hidden: projects.length - shown.length };
}

function lanesOf(lanes: NonNullable<Header["lanes"]>, every: boolean): Record<string, unknown> {
  const record: Record<string, unknown> = {
    lanes:
      lanes.lanes.length === 0
        ? "0 lanes"
        : lanes.lanes.map((each) =>
            every
              ? { name: each.lane, host: each.host, state: each.state, detail: each.detail }
              : { name: each.lane, state: each.state },
          ),
  };
  if (lanes.unreachable.length > 0) record["unreachable"] = lanes.unreachable;
  return record;
}

function headerOf(
  header: Header,
  open: readonly BoardCard[],
  query: BoardQuery,
): { record: Record<string, unknown>; help: string[] } {
  const projects = projectsOf(header.projects, open, query.projects === true);
  const record: Record<string, unknown> = { projects: projects.rows };
  const help: string[] = [];
  if (projects.hidden > 0)
    help.push(
      `Call \`board(projects=true)\` to list ${String(projects.hidden)} more projects, with their base branch`,
    );
  if (header.lanes !== undefined) {
    Object.assign(record, lanesOf(header.lanes, query.lanes === true));
    const down = header.lanes.lanes.some((each) => each.state !== "running");
    if (down && query.lanes !== true)
      help.push("Call `board(lanes=true)` to see why a lane is down or stopped");
    if (down)
      help.push('Call `lane(name=<lane>, action="start")` to start a lane that is down or stopped');
  }
  return { record, help };
}
