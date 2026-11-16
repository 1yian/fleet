import type { DatabaseSync } from "node:sqlite";
import { check, OPS, type Card } from "@fleet/protocol";
import { routed } from "@fleet/protocol/route";
import { runOnTransport } from "@fleet/protocol/transport";
import Type from "typebox";
import { captainWrote, NOT_SAID } from "./authority.ts";
import { routeFor } from "./merged-report.ts";
import type { Hosts } from "./pulls.ts";
import { factsFrom, type Hold } from "./status.ts";
import { cardEntries, getCard } from "./store.ts";
import { containsWords } from "./words.ts";

const READ_TIMEOUT_MS = 30_000;
const READ_LIMIT_BYTES = 64 * 1024 * 1024;
const READ_RECORD =
  'if [ -n "$LAVISH_AXI_STATE_DIR" ]; then cat "$LAVISH_AXI_STATE_DIR/state.json"; else cat "$HOME/.lavish-axi/state.json"; fi';
const PAGE_LINK = /\/session\/([0-9a-f]{8,64})\b/g;

export interface ReviewEvidence {
  readonly host: string;
  readonly session: string;
  readonly file: string;
  readonly at: string;
  readonly report: number;
  readonly keys: readonly string[];
  readonly occurrence: number;
}

export type ReviewReading = ReviewEvidence | { readonly refused: string };

export interface Proof {
  readonly source: string;
  readonly review?: ReviewEvidence;
}

const RecordSchema = Type.Object({ sessions: Type.Record(Type.String(), Type.Unknown()) });

const RoundRow = Type.Object({
  id: Type.Integer(),
  body: Type.String(),
  at: Type.Integer(),
  key: Type.String(),
  host: Type.String(),
});

interface Round {
  readonly report: number;
  readonly key: string;
  readonly at: number;
  readonly host: string;
  readonly sessions: readonly string[];
}

interface Page {
  readonly host: string;
  readonly session: string;
  readonly report: number;
}

interface Message {
  readonly text: string;
  readonly at: string;
  readonly sent: number;
}

const refused = (why: string): { readonly refused: string } => ({ refused: why });

function readRecord(hosts: Hosts, host: string): Promise<string> {
  const [file = "sh", ...args] = routed(routeFor(hosts, host), ["sh", "-c", READ_RECORD]);
  return new Promise((resolve, reject) => {
    runOnTransport(
      file,
      args,
      { timeout: READ_TIMEOUT_MS, maxBuffer: READ_LIMIT_BYTES },
      (error, out, err) => {
        if (error === null) resolve(out);
        else reject(new Error(err.trim() === "" ? error.message : err.trim()));
      },
    );
  });
}

function roundsOf(db: DatabaseSync, card: number, keys: readonly string[]): Round[] {
  const rows = db
    .prepare(
      `SELECT e.id AS id, e.body AS body, e.created_at AS at,
         coalesce(json_extract(e.fields, '$.key'), '') AS key, a.host AS host
       FROM entries e
       JOIN sessions s ON 'worker:' || s.id = e.author
       JOIN attempts a ON a.id = s.attempt
       WHERE e.card = ? AND e.kind = 'report' AND json_extract(e.fields, '$.status') = 'needs-decision'
       ORDER BY e.id`,
    )
    .all(card);
  const latest = new Map<string, Round>();
  for (const row of rows) {
    const found = check(RoundRow, { ...row });
    if (!keys.includes(found.key)) continue;
    const sessions = [...found.body.matchAll(PAGE_LINK)].flatMap((link) => link[1] ?? []);
    latest.set(found.key, {
      report: found.id,
      key: found.key,
      at: found.at,
      host: found.host,
      sessions,
    });
  }
  return [...latest.values()];
}

function pagesOf(rounds: readonly Round[]): Page[] {
  const seen = new Map<string, Page>();
  for (const round of rounds)
    for (const session of round.sessions)
      seen.set(`${round.host} ${session}`, { host: round.host, session, report: round.report });
  return [...seen.values()];
}

const folderOf = (card: number): RegExp =>
  new RegExp(`(^|/)(c-${String(card)}(-a\\d+)?|fleet-c-${String(card)})/`);

function userMessage(value: unknown): Message | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const role: unknown = Reflect.get(value, "role");
  const text: unknown = Reflect.get(value, "text");
  const at: unknown = Reflect.get(value, "at");
  if (role !== "user" || typeof text !== "string" || typeof at !== "string") return undefined;
  const sent = Date.parse(at);
  return Number.isNaN(sent) ? undefined : { text, at, sent };
}

function sessionIn(record: unknown, key: string): { file: string; chat: unknown[] } | undefined {
  const { sessions } = check(RecordSchema, record);
  const session = sessions[key];
  if (typeof session !== "object" || session === null) return undefined;
  const file: unknown = Reflect.get(session, "file");
  const chat: unknown = Reflect.get(session, "chat");
  if (typeof file !== "string") return undefined;
  return { file, chat: Array.isArray(chat) ? chat : [] };
}

interface Look {
  readonly card: Card;
  readonly open: Hold;
  readonly words: string;
  readonly since: number;
}

function spoken(page: Page, look: Look, record: unknown): ReviewEvidence | string {
  const session = sessionIn(record, page.session);
  if (session === undefined) return `Lavish on ${page.host} has no page session ${page.session}`;
  if (!folderOf(look.card.id).test(session.file))
    return `the page ${session.file} is not in c-${String(look.card.id)}'s own folders`;
  const heard = session.chat
    .map(userMessage)
    .find(
      (message) =>
        message !== undefined &&
        message.sent > look.since &&
        containsWords(message.text, look.words),
    );
  if (heard === undefined)
    return `no message from the page ${session.file} with these words came after the review was opened`;
  return {
    host: page.host,
    session: page.session,
    file: session.file,
    at: heard.at,
    report: page.report,
    keys: look.open.keys,
    occurrence: look.open.occurrence,
  };
}

export async function readReview(
  db: DatabaseSync,
  hosts: Hosts,
  card: Card,
  open: Hold,
  words: string,
): Promise<ReviewReading> {
  const name = `c-${String(card.id)}`;
  if (open.merge)
    return refused(
      "review-page feedback never approves a merge: a merge needs the captain's words in your chat or on the board",
    );
  if (!open.fromWorker || open.keys.length === 0)
    return refused(
      `${name}'s hold is not a worker's review question, so a review page cannot answer it`,
    );
  const rounds = roundsOf(db, card.id, open.keys);
  const pages = pagesOf(rounds);
  if (pages.length === 0)
    return refused(
      `the worker's reports for ${open.keys.join(", ")} link no Lavish page, so no review page is known for ${name}`,
    );
  const since = Math.max(...rounds.map((round) => round.at));
  const look = { card, open, words, since };
  const records = new Map<string, Promise<unknown>>();
  const reasons: string[] = [];
  for (const page of pages) {
    const read =
      records.get(page.host) ??
      readRecord(hosts, page.host).then((text): unknown => JSON.parse(text));
    records.set(page.host, read);
    try {
      const found = spoken(page, look, await read);
      if (typeof found !== "string") return found;
      reasons.push(found);
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      reasons.push(`Lavish's record on ${page.host} could not be read: ${why}`);
    }
  }
  return refused(reasons.join("; "));
}

export async function reviewOf(
  db: DatabaseSync,
  hosts: Hosts,
  raw: unknown,
): Promise<ReviewReading | undefined> {
  const args = check(OPS.release.args, raw);
  if (args.words === undefined || (args.source ?? "record") !== "record") return undefined;
  if (captainWrote(db, args.words)) return undefined;
  const card = getCard(db, args.card);
  const open = factsFrom(cardEntries(db, card.id)).hold;
  if (open === undefined) return undefined;
  return readReview(db, hosts, card, open, args.words);
}

export function proveWords(
  db: DatabaseSync,
  open: Hold,
  words: string,
  source: string,
  review: ReviewReading | undefined,
): Proof {
  if (source === "chat" || captainWrote(db, words)) return { source };
  if (review === undefined) throw new Error(NOT_SAID);
  if ("refused" in review) throw new Error(`${NOT_SAID} (${review.refused})`);
  if (open.merge || review.occurrence !== open.occurrence)
    throw new Error(`${NOT_SAID} (the hold changed while its review page was read)`);
  return { source: "review", review };
}
