import type { Entry, Holder } from "@fleet/protocol";
import { holdDeferred, type Hold } from "./status.ts";
import { parentOf, type Session } from "./store.ts";
import type { DatabaseSync } from "node:sqlite";

function stockSession(value: string): URL | undefined {
  const url = URL.parse(value);
  if (
    value.length > 512 ||
    url === null ||
    !["http:", "https:"].includes(url.protocol) ||
    !/^\/session\/[a-f0-9]{16}$/.test(url.pathname) ||
    value !== url.origin + url.pathname
  )
    return undefined;
  return url;
}

const loopback = (url: URL): boolean => url.hostname === "127.0.0.1" && url.protocol === "http:";
const bare = (host: string): string => host.replace(/\.$/, "");

function originMapping(mapping: string, boardHost: string): [URL, URL] {
  const [reported, upstream, extra] = mapping.split("=");
  if (!reported || !upstream || extra !== undefined)
    throw new Error("review origins must use reported-origin=upstream-origin");
  const source = new URL(reported);
  const target = new URL(upstream);
  const bad =
    source.origin !== reported ||
    !["http:", "https:"].includes(source.protocol) ||
    target.origin !== upstream ||
    bare(target.hostname) === boardHost ||
    (target.protocol !== "https:" && !loopback(target));
  if (bad)
    throw new Error(
      "map each Lavish origin to a separate HTTPS upstream (HTTP loopback is for labs)",
    );
  return [source, target];
}

export function reviewOrigins(
  raw: string | undefined,
  boardHost: string | undefined,
): ReadonlyMap<string, string> {
  const origins = new Map<string, string>();
  if (raw === undefined) return origins;
  if (boardHost === undefined)
    throw new Error("review origins require Cloudflare Access for the board");
  for (const mapping of raw.trim().split(/\s+/)) {
    const [source, target] = originMapping(mapping, boardHost);
    if (origins.has(source.origin)) throw new Error("map each Lavish origin only once");
    origins.set(source.origin, target.origin);
  }
  return origins;
}

let known: ReadonlyMap<string, string> = new Map();

export function setReviewOrigins(origins: ReadonlyMap<string, string>): void {
  known = origins;
}

function resolvedUpstream(review: string | false): string | undefined {
  const reported = review === false ? undefined : stockSession(review);
  const upstream = reported === undefined ? undefined : known.get(reported.origin);
  return reported === undefined || upstream === undefined
    ? undefined
    : new URL(reported.pathname, upstream).href;
}

export function reviewArtifactOrigin(
  raw: string | undefined,
  boardHost: string | undefined,
  origins: ReadonlyMap<string, string>,
): URL | undefined {
  if (raw === undefined) return undefined;
  const url = new URL(raw);
  const sources = [...origins.values()].map((origin) => bare(new URL(origin).hostname));
  if (
    boardHost === undefined ||
    raw !== url.origin ||
    url.protocol !== "https:" ||
    bare(url.hostname) === boardHost ||
    sources.includes(bare(url.hostname))
  )
    throw new Error(
      "review artifacts need their own HTTPS hostname, separate from board and source hosts",
    );
  return url;
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

function mentionsReview(body: string): boolean {
  return body.split(/\s+/).some((word) => stockSession(word) !== undefined);
}

function requestsOf(entries: readonly Entry[], open: Hold | undefined): Entry[] {
  if (open?.fromWorker !== true || open.keys.length === 0)
    throw new Error("a review hold needs open worker decision keys");
  return open.keys.map((key) => {
    const request = latestRequest(entries, key);
    if (request === undefined) throw new Error(`decision key ${key} has no request`);
    return request;
  });
}

function reviewRequests(
  entries: readonly Entry[],
  open: Hold | undefined,
  session: string | false,
): number[] {
  if (session !== false && stockSession(session) === undefined)
    throw new Error("the review session must be a canonical stock Lavish URL");
  const requests = requestsOf(entries, open);
  if (
    session === false &&
    open?.review === undefined &&
    !requests.some((r) => mentionsReview(r.body))
  )
    throw new Error("review=false is only for decisions that include a Lavish review");
  const missing = requests.find((r) => session !== false && !r.body.split(/\s+/).includes(session));
  if (missing !== undefined)
    throw new Error(
      `decision key ${String(missing.fields["key"])} does not name the review session as a standalone link`,
    );
  return requests.map((request) => request.id);
}

export function boundReview(
  db: DatabaseSync,
  session: Session,
  entries: readonly Entry[],
  open: Hold | undefined,
  target: Holder,
  protectedWork: boolean,
  review: string | false | undefined,
) {
  const carried = {
    review: open?.review,
    reviewRequests: open?.reviewRequests,
    reviewUpstream: open?.reviewUpstream,
  };
  if (review === undefined) return { fields: carried, compare: carried };
  const second = parentOf(db, session.lane) !== null;
  if (target !== (second ? "main" : "captain") || (review !== false && protectedWork))
    throw new Error("only a hold on its way to the captain can be bound for review alone");
  const requests = reviewRequests(entries, open, review);
  const compare = { review: review === false ? undefined : review, reviewRequests: requests };
  return {
    fields: { review, reviewRequests: requests, reviewUpstream: resolvedUpstream(review) },
    compare,
  };
}

function matchesRequests(hold: Hold, requests: readonly number[]): boolean {
  const bound = hold.reviewRequests;
  return (
    bound !== undefined &&
    requests.length > 0 &&
    requests.length === bound.length &&
    requests.every((id, at) => id !== 0 && id === bound[at])
  );
}

export function reviewDecision(entries: readonly Entry[], hold: Hold) {
  return (
    hold.reviewRequests !== undefined &&
    matchesRequests(
      hold,
      hold.keys.map((key) => latestRequest(entries, key)?.id ?? 0),
    )
  );
}

function reviewLink(hold: Hold, now: number): URL | undefined {
  if (
    hold.review === undefined ||
    hold.holder !== "captain" ||
    hold.merge ||
    hold.unlanded ||
    holdDeferred(hold, now)
  )
    return undefined;
  return stockSession(hold.review);
}

export function reviewPreview(
  hold: Hold,
  origins: ReadonlyMap<string, string>,
  now: number,
): URL | undefined {
  const reported = reviewLink(hold, now);
  if (reported === undefined) return undefined;
  const upstream = origins.get(reported.origin);
  return upstream === undefined ? undefined : new URL(reported.pathname, upstream);
}

export function recordedUpstream(hold: Hold): string | undefined {
  return reviewLink(hold, Infinity) === undefined ? undefined : hold.reviewUpstream;
}
