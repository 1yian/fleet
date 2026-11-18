import type { Entry } from "@fleet/protocol";
import { holdDeferred, type Hold } from "./status.ts";

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

export function reviewOrigins(
  raw: string | undefined,
  boardHost: string | undefined,
): ReadonlyMap<string, string> {
  const origins = new Map<string, string>();
  if (raw === undefined) return origins;
  if (boardHost === undefined)
    throw new Error("review origins require Cloudflare Access for the board");
  for (const mapping of raw.trim().split(/\s+/)) {
    const [reported, upstream, extra] = mapping.split("=");
    if (!reported || !upstream || extra !== undefined)
      throw new Error("review origins must use reported-origin=upstream-origin");
    const source = new URL(reported);
    const target = new URL(upstream);
    if (
      source.origin !== reported ||
      !["http:", "https:"].includes(source.protocol) ||
      target.origin !== upstream ||
      target.hostname.replace(/\.$/, "") === boardHost ||
      (target.protocol !== "https:" &&
        !(target.hostname === "127.0.0.1" && target.protocol === "http:")) ||
      origins.has(source.origin)
    )
      throw new Error(
        "map each Lavish origin to a separate HTTPS upstream (HTTP loopback is for labs)",
      );
    origins.set(source.origin, target.origin);
  }
  return origins;
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
  if (stockSession(session) === undefined)
    throw new Error("the review session must be a canonical stock Lavish URL");
  if (open?.fromWorker !== true || open.keys.length === 0)
    throw new Error("a review hold needs open worker decision keys");
  const requests = open.keys.map((key) => {
    const request = latestRequest(entries, key);
    if (!request?.body.split(/\s+/).includes(session))
      throw new Error(`decision key ${key} does not name the review session as a standalone link`);
    return request.id;
  });
  return requests;
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
    hold.review !== undefined &&
    matchesRequests(
      hold,
      hold.keys.map((key) => latestRequest(entries, key)?.id ?? 0),
    )
  );
}

export function reviewPreview(
  hold: Hold,
  origins: ReadonlyMap<string, string>,
  now: number,
): URL | undefined {
  if (
    hold.review === undefined ||
    hold.holder !== "captain" ||
    hold.merge ||
    hold.unlanded ||
    holdDeferred(hold, now)
  )
    return undefined;
  const reported = stockSession(hold.review);
  if (reported === undefined) return undefined;
  const upstream = origins.get(reported.origin);
  return upstream === undefined ? undefined : new URL(reported.pathname, upstream);
}
