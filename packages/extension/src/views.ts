// What the mate's read tools print (https://axi.md): TOON records, a few fields by default,
// counts up front, long text cut with its size, an explicit empty state, and next steps.
// Pure: data in, text out.
import type { BoardCard, CardView, Entry, Status } from "@fleet/protocol";
import { encode } from "@toon-format/toon";

/** The statuses in the order that needs attention: the captain's holds first, then the mate's, then running work. */
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
/** Who moves a card in each status when no hold names someone. */
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

/** Who acts next on the card: who its hold waits on, else who moves its work. */
function waits(card: BoardCard): string {
  if (card.holder === "captain" || card.holder === "main") return card.holder;
  const mover = card.holder === "owner" ? "lane" : MOVER[card.status];
  return mover === "lane" ? card.lane : mover;
}

/** How long ago, or how long until, a time: 45s ago, 12m ago, in 3h, 2d ago. */
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

/** Text cut to `max` characters, with its full size and the way to see it all. */
function cut(text: string, max: number, full: boolean): string {
  if (full || text.length <= max) return text;
  return `${text.slice(0, max).trimEnd()}... (truncated, ${String(text.length)} chars total, full=true shows all)`;
}

/** Columns a board row can show. The first four show by default. */
const COLUMNS = {
  card: (card: BoardCard) => card.id,
  status: (card: BoardCard) => card.status,
  waits,
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
const DEFAULT_COLUMNS = ["card", "status", "waits", "title"] as const;
const isColumn = (name: string): name is Column => Object.hasOwn(COLUMNS, name);
const isDefault = (name: string): boolean => DEFAULT_COLUMNS.some((each) => each === name);
export const EXTRA_COLUMNS = Object.keys(COLUMNS).filter((each) => !isDefault(each));

/** Help lines in the AXI shape: a counted list of next steps, one per line. */
const helpLines = (lines: readonly string[]): string =>
  lines.length === 0
    ? ""
    : `\nhelp[${String(lines.length)}]:\n${lines.map((line) => `  ${line}`).join("\n")}`;

/** A structured error: what went wrong and the calls that fix it. */
export const errorText = (message: string, help: readonly string[]): string =>
  encode({ error: message }) + helpLines(help);

/** "3 (needs-you 1, working 2)": a total and its nonzero counts by status, in attention order. */
function tally(cards: readonly BoardCard[]): string | number {
  const parts = ORDER.flatMap((status) => {
    const n = cards.filter((card) => card.status === status).length;
    return n === 0 ? [] : [`${status} ${String(n)}`];
  });
  return parts.length === 0 ? 0 : `${String(cards.length)} (${parts.join(", ")})`;
}

/** The default columns and the asked ones. Throws a structured error for a name that is not a column. */
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
  readonly lane?: string;
  /** The most closed cards to list, newest first. */
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

/** The rows a query lists: matching open cards by attention, then the newest matching closed cards. */
function rowsOf(cards: readonly BoardCard[], selection: Selection, limit: number) {
  const matched = cards.filter((card) => selects(selection, card)).sort(byAttention);
  const open = matched.filter((card) => !isClosed(card));
  const closed = matched.filter(isClosed).sort((a, b) => b.updatedAt - a.updatedAt);
  return { rows: [...open, ...closed.slice(0, limit)], hidden: Math.max(0, closed.length - limit) };
}

/** The board: live cards first in the order that needs attention, closed cards only when asked and counted always. */
export function boardText(all: readonly BoardCard[], query: BoardQuery): string {
  const columns = columnsOf(query.fields);
  const selection = query.status ?? "open";
  const lane = query.lane;
  const cards = lane === undefined ? all : all.filter((card) => card.lane === lane);
  const { rows, hidden } = rowsOf(cards, selection, query.limit ?? CLOSED_LIMIT);
  const closed = cards.filter(isClosed);

  const record: Record<string, unknown> = lane === undefined ? {} : { lane };
  record["open"] = tally(cards.filter((card) => !isClosed(card)));
  record["closed"] = tally(closed);
  if (hidden > 0) record["hidden"] = `${String(hidden)} older closed cards`;
  const what = `${selection === "all" ? "" : `${selection} `}cards${lane === undefined ? "" : ` in lane ${lane}`}`;
  record["cards"] =
    rows.length === 0
      ? `0 ${what}`
      : rows.map((card) => Object.fromEntries(columns.map((each) => [each, COLUMNS[each](card)])));
  return encode(record) + helpLines(boardHelp(query, rows.length, closed.length, hidden));
}

function boardHelp(query: BoardQuery, rows: number, closed: number, hidden: number): string[] {
  const help: string[] = [];
  if (rows > 0)
    help.push("Call `card(card=<card>)` to read a card: its hold, PR, branch, and thread");
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
  /** How many entries to show, newest first. */
  readonly entries?: number;
  /** Show every text whole. */
  readonly full?: boolean;
}

const ENTRY_LIMIT = 10;

/** A report's status or a hold's holder, next to the entry kind: report/done, hold/captain. */
function kindOf(entry: Entry): string {
  const detail = entry.fields[entry.kind === "hold" ? "holder" : "status"];
  return typeof detail === "string" && detail !== "" ? `${entry.kind}/${detail}` : entry.kind;
}

/** The path a scout's done report names, as in "report written: /tmp/report.md". */
function reportPath(entries: readonly Entry[]): string | undefined {
  for (const entry of [...entries].reverse()) {
    if (entry.kind !== "report") continue;
    const found = /report written:\s*(\S+?)[.,;:]?(?=\s|$)/i.exec(entry.body);
    if (found?.[1] !== undefined) return found[1];
  }
  return undefined;
}

type Cut = (text: string, max: number) => string;

/** The card's own fields, and its open hold. */
function about({ card, hold }: CardView, clip: Cut): Record<string, unknown> {
  const record: Record<string, unknown> = {
    card: {
      id: card.id,
      name: card.name,
      title: card.title,
      kind: card.kind,
      project: card.project ?? "none",
      lane: card.lane,
      status: card.status,
      waits: waits(card),
      pr: card.pr ?? "none",
      updated: ago(card.updatedAt),
    },
  };
  if (hold === null) return record;
  record["hold"] = {
    waits: hold.holder === "owner" ? card.lane : hold.holder,
    question: clip(hold.question, 600),
    options: hold.options,
    ...(hold.until === null ? {} : { until: ago(hold.until) }),
  };
  return record;
}

/** One card: what it is, who it waits on, where its work runs, and its thread, newest first. */
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

/** Next steps on a card. `thread` is the thread's size when some entries are hidden, else 0. Read the hidden entries, read the cut texts whole, and steer it while it is open. */
function cardHelp(card: BoardCard, thread: number, clipped: boolean): string[] {
  const id = String(card.id);
  const help: string[] = [];
  if (thread > 0)
    help.push(`Call \`card(card=${id}, entries=${String(thread)})\` to read the whole thread`);
  if (clipped) help.push(`Call \`card(card=${id}, full=true)\` to see every text whole`);
  if (!isClosed(card)) help.push(`Call \`comment(card=${id}, text=<text>)\` to steer the card`);
  return help;
}

export interface ProjectRow {
  readonly name: string;
  readonly delivery: string;
  readonly base: string;
  readonly hosts: readonly string[];
}

export function projectsText(projects: readonly ProjectRow[]): string {
  if (projects.length === 0) return encode({ projects: "0 registered" });
  const rows = projects.map((each) => ({
    name: each.name,
    delivery: each.delivery,
    base: each.base,
    hosts: each.hosts.join(" "),
  }));
  const next = "Call `card_new(title=<title>, kind=<kind>, project=<name>)` to start work on one";
  return encode({ count: projects.length, projects: rows }) + helpLines([next]);
}

export interface LaneRow {
  readonly lane: string;
  readonly host: string;
  readonly state: string;
  readonly detail: string;
}

/** Every lane on every host, counted by state, and the hosts that did not answer. */
export function lanesText(
  lanes: readonly LaneRow[],
  unreachable: readonly { host: string; error: string }[],
): string {
  const states = [...new Set(lanes.map((each) => each.state))];
  const counts = states.map(
    (state) => `${state} ${String(lanes.filter((each) => each.state === state).length)}`,
  );
  const record: Record<string, unknown> = {
    count: lanes.length === 0 ? "0 lanes" : `${String(lanes.length)} (${counts.join(", ")})`,
  };
  if (lanes.length > 0) record["lanes"] = lanes;
  if (unreachable.length > 0) record["unreachable"] = unreachable;
  const help = lanes.some((each) => each.state !== "running")
    ? ["Call `lane_start(lane=<lane>)` to start a lane that is down or stopped"]
    : [];
  return encode(record) + helpLines(help);
}
