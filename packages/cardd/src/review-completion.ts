import { createPublicKey, type KeyObject } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { check, type Entry } from "@fleet/protocol";
import { jwtVerify } from "jose";
import Type, { type Static } from "typebox";
import { factsFrom, type Hold } from "./status.ts";
import { addEntry, cardEntries, getCard, parentOf } from "./store.ts";

const Session = Type.String({ pattern: "^https?://[^/]+/session/[a-f0-9]{8,64}$", maxLength: 512 });
const Completion = Type.Object({
  card: Type.Integer({ minimum: 1 }),
  round: Type.Integer({ minimum: 1 }),
  session: Session,
  action: Type.Literal("send-and-end"),
  words: Type.String({ maxLength: 2000 }),
});

type Receipt = Static<typeof Completion>;

export function reviewKey(pem: string | undefined): KeyObject | undefined {
  if (pem === undefined) return undefined;
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== "ed25519")
    throw new Error("review completion needs an Ed25519 public key");
  return key;
}

export async function readCompletion(key: KeyObject, token: string): Promise<Receipt> {
  const { payload } = await jwtVerify(token, key, {
    algorithms: ["EdDSA"],
    audience: "fleet-review-completion",
    typ: "fleet-review-completion+jwt",
    requiredClaims: ["exp", "iat"],
    maxTokenAge: "5 minutes",
  });
  return check(Completion, payload);
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

function matchingHold(entries: readonly Entry[], receipt: Receipt): Hold | undefined {
  const open = factsFrom(entries).hold;
  if (open?.holder !== "captain" || open.entry !== receipt.round || open.merge || open.unlanded)
    return undefined;
  const requests = open.keys.map((key) => latestRequest(entries, key)?.id);
  if (requests.length === 0 || JSON.stringify(open.reviewRequests) !== JSON.stringify(requests))
    return undefined;
  return open;
}

export function settleReview(db: DatabaseSync, receipt: Receipt): readonly string[] | undefined {
  const entries = cardEntries(db, receipt.card);
  const round = entries.find((entry) => entry.id === receipt.round && entry.kind === "hold");
  if (round?.fields["review"] !== receipt.session) return undefined;
  if (
    entries.some(
      (entry) => entry.kind === "review-feedback" && entry.fields["round"] === receipt.round,
    )
  )
    return [];
  const open = matchingHold(entries, receipt);
  if (open === undefined) return undefined;
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
