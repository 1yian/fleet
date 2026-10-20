// comment (spec sections 9.1, 10.1, and 10.3): the one way to talk to an agent. A
// comment on a card goes to the agent that owns it. A worker's card hears its mate.
// A second mate's lane card, or any card in that lane, hears main when main speaks and
// main hears the second mate when it answers. Main never steers another lane's worker.
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

/** The card the comment is for: the card given, or the lane card of the lane given. */
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

/** Where a comment goes, and what it does to the card. */
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
  // A steer opens the work again, so a merge question about the old head no longer stands.
  let withdrawn: string[] = [];
  if (route.kind === "worker") {
    requireNotCaptains(db, card, args.resolves);
    withdrawn = withdrawMerge(db, card);
  }
  // `for` marks a comment that reached a session: the first report or action after it answers it.
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

/** A comment cannot answer a worker's decision that waits on the captain: his words release it first. */
function requireNotCaptains(db: DatabaseSync, card: Card, resolves: string | undefined): void {
  const open = holdOf(db, card);
  if (resolves !== undefined && open?.holder === "captain" && open.keys.includes(resolves)) {
    throw new Error(
      `the captain holds c-${String(card.id)}: release it with his exact words, then answer the worker`,
    );
  }
}
