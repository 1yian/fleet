import type { DatabaseSync } from "node:sqlite";
import { check, type Entry } from "@fleet/protocol";
import Type from "typebox";
import { factsFrom, type Hold } from "./status.ts";
import { addEntry, cardEntries, getCard, parentOf } from "./store.ts";

const Session = Type.String({ pattern: "^https?://[^/]+/session/[a-f0-9]{8,64}$", maxLength: 512 });
interface Round {
  readonly card: number;
  readonly round: number;
}

interface Receipt extends Round {
  readonly session: string;
  readonly words: string;
}

export function reviewOrigins(
  raw: string | undefined,
  boardHost: string | undefined,
): ReadonlySet<string> {
  if (raw === undefined) return new Set();
  if (boardHost === undefined)
    throw new Error("review origins require Cloudflare Access for the board");
  const origins = raw.trim().split(/\s+/);
  for (const origin of origins) {
    const url = new URL(origin);
    const loopback = ["127.0.0.1", "[::1]"].includes(url.hostname);
    if (
      url.origin !== origin ||
      url.hostname === boardHost ||
      (url.protocol !== "https:" && !(loopback && url.protocol === "http:"))
    )
      throw new Error(
        "review origins must be HTTPS origins separate from the board (HTTP loopback is for labs)",
      );
  }
  return new Set(origins);
}

function latestRequest(entries: readonly Entry[], key: string): Entry | undefined {
  return entries.findLast(
    (entry) =>
      entry.kind === "report" &&
      entry.author.startsWith("worker:") &&
      entry.fields["status"] === "needs-decision" &&
      entry.fields["key"] === key,
  );
}

export function reviewRequests(
  entries: readonly Entry[],
  open: Hold | undefined,
  session: string,
): number[] {
  check(Session, session);
  const url = new URL(session);
  if (url.href !== session || url.username !== "" || url.password !== "")
    throw new Error("the review session must be a canonical Lavish URL");
  if (open?.fromWorker !== true || open.keys.length === 0)
    throw new Error("a review hold needs open worker decision keys");
  return open.keys.map((key) => {
    const request = latestRequest(entries, key);
    if (!request?.body.split(/\s+/).includes(session))
      throw new Error(`decision key ${key} does not name the review session as a standalone link`);
    return request.id;
  });
}

function matchingHold(entries: readonly Entry[], receipt: Round): Hold | undefined {
  const open = factsFrom(entries).hold;
  if (open?.holder !== "captain" || open.entry !== receipt.round || open.merge || open.unlanded)
    return undefined;
  const requests = open.keys.map((key) => latestRequest(entries, key)?.id);
  if (requests.length === 0 || JSON.stringify(open.reviewRequests) !== JSON.stringify(requests))
    return undefined;
  return open;
}

function recorded(entries: readonly Entry[], round: Round): boolean {
  return entries.some(
    (entry) =>
      entry.kind === "review-feedback" &&
      entry.fields["source"] === "lavish" &&
      entry.fields["round"] === round.round,
  );
}

export const RECORDED_REVIEW = Symbol("recorded review");

export function boundReviewPage(
  db: DatabaseSync,
  round: Round,
): string | typeof RECORDED_REVIEW | undefined {
  const entries = cardEntries(db, round.card);
  if (recorded(entries, round)) return RECORDED_REVIEW;
  return matchingHold(entries, round)?.review;
}

export function settleReview(db: DatabaseSync, receipt: Receipt): readonly string[] | undefined {
  const entries = cardEntries(db, receipt.card);
  if (recorded(entries, receipt)) return [];
  const open = matchingHold(entries, receipt);
  if (open?.review !== receipt.session) return undefined;
  const { lane } = getCard(db, receipt.card);
  const parent = parentOf(db, lane);
  const notify = parent === null ? [lane] : [lane, parent];
  addEntry(
    db,
    {
      card: receipt.card,
      author: "captain",
      kind: "review-feedback",
      body: receipt.words,
      fields: { source: "lavish", round: receipt.round, session: receipt.session, keys: open.keys },
    },
    notify,
  );
  return notify;
}
