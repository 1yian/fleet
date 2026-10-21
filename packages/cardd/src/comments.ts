import type { DatabaseSync } from "node:sqlite";
import { check, OPS, type Card } from "@fleet/protocol";
import { applyChange, type Draft } from "./change.ts";
import { withEcho } from "./echo.ts";
import { holdOf, withdrawMerge } from "./holds.ts";
import {
  addEntry,
  getCard,
  isLaneCard,
  laneCardOf,
  parentOf,
  reachable,
  workerOf,
  type Session,
} from "./store.ts";

interface Done {
  readonly value: unknown;
  readonly notify: readonly string[];
}

function target(db: DatabaseSync, session: Session, args: { card?: number; lane?: string }): Card {
  if ((args.card === undefined) === (args.lane === undefined)) {
    throw new Error("comment needs either card or lane, and not both");
  }
  if (args.card !== undefined) return reachable(db, session, args.card).card;
  const lane = args.lane ?? "";
  if (lane !== session.lane && parentOf(db, lane) !== session.lane) {
    throw new Error(`lane ${lane} is not your lane or one of your second mates`);
  }
  const card = laneCardOf(db, lane);
  if (card === undefined) throw new Error(`lane ${lane} has no lane card`);
  return getCard(db, card);
}

type Route =
  | { readonly kind: "worker" }
  | { readonly kind: "mate"; readonly to: string }
  | { readonly kind: "main"; readonly to: string };

function routeOf(db: DatabaseSync, session: Session, card: Card): Route {
  if (card.lane !== session.lane) return { kind: "mate", to: card.lane };
  const parent = parentOf(db, session.lane);
  if (isLaneCard(db, card) && parent !== null) return { kind: "main", to: parent };
  return { kind: "worker" };
}

export function comment(db: DatabaseSync, session: Session, raw: unknown): Done {
  const args = check(OPS.comment.args, raw);
  const card = target(db, session, args);
  const route = routeOf(db, session, card);
  if (route.kind !== "worker" && args.resolves !== undefined) {
    throw new Error("resolves answers a worker's decision key; only the mate of a card has one");
  }
  const worker = route.kind === "worker" ? workerOf(db, card.id) : undefined;
  const recipient = route.kind === "worker" ? worker : route.to;
  let withdrawn: string[] = [];
  if (route.kind === "worker") {
    requireNotCaptains(db, card, args.resolves);
    withdrawn = withdrawMerge(db, card);
  }
  const delivered = recipient === undefined ? {} : { for: route.kind };
  const own = { resolves: args.resolves, now: args.now, ...delivered };
  const { to, fields } = withEcho(
    db,
    session,
    card,
    recipient === undefined ? [] : [recipient],
    own,
  );
  const draft: Draft = {
    card: card.id,
    author: `mate:${session.lane}`,
    kind: "comment",
    body: args.text,
    fields,
  };
  if (route.kind === "worker") applyChange(db, card, { kind: "comment" }, [draft]);
  addEntry(db, draft, to);
  return { value: getCard(db, card.id), notify: [...to, ...withdrawn] };
}

function requireNotCaptains(db: DatabaseSync, card: Card, resolves: string | undefined): void {
  const open = holdOf(db, card);
  if (resolves !== undefined && open?.holder === "captain" && open.keys.includes(resolves)) {
    throw new Error(
      `the captain holds c-${String(card.id)}: clear the hold with his exact words, then answer the worker`,
    );
  }
}
