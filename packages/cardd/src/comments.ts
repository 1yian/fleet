import type { DatabaseSync } from "node:sqlite";
import { CAPTAIN, check, OPS, type Card, type OpArgs } from "@fleet/protocol";
import { requireOpen, type Draft } from "./change.ts";
import { withEcho } from "./echo.ts";
import { holdOf, withdrawMerge } from "./holds.ts";
import { askersOf, isCaptainsReply, requireAskedBy, requireOwedBy } from "./replies.ts";
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

type CommentArgs = OpArgs<"comment">;

function answerReply(db: DatabaseSync, session: Session, card: Card, args: CommentArgs): Done {
  const id = args.replyTo ?? "";
  if (args.reply === true || args.resolves !== undefined || args.withdraws !== undefined)
    throw new Error("replyTo answers a reply you owe: give it with text alone");
  requireOwedBy(db, card, id, `mate:${session.lane}`);
  const to = withEcho(db, session, card, askersOf(db, card, id));
  const toCaptain = isCaptainsReply(db, card, id) ? { for: CAPTAIN } : {};
  const fields = { replyTo: id, now: args.now, ...toCaptain };
  const draft = {
    card: card.id,
    author: `mate:${session.lane}`,
    kind: "comment",
    body: args.text,
    fields,
  };
  addEntry(db, draft, to);
  return { value: getCard(db, card.id), notify: to };
}

function requireOwnKeys(
  db: DatabaseSync,
  session: Session,
  card: Card,
  route: Route,
  args: CommentArgs,
): void {
  if (route.kind !== "worker" && args.resolves !== undefined) {
    throw new Error("resolves answers a worker's decision key; only the mate of a card has one");
  }
  if (args.withdraws !== undefined) requireAskedBy(db, card, args.withdraws, session.lane);
}

function owesOf(route: Route, recipient: string | undefined, card: Card): { owes?: string } {
  if (route.kind === "main")
    throw new Error("reply asks your worker or a second mate for an answer, not main");
  if (recipient === undefined)
    throw new Error(`c-${String(card.id)} has no live worker to owe you a reply`);
  return { owes: recipient };
}

export function comment(db: DatabaseSync, session: Session, raw: unknown): Done {
  const args = check(OPS.comment.args, raw);
  const card = target(db, session, args);
  if (args.replyTo !== undefined) return answerReply(db, session, card, args);
  const route = routeOf(db, session, card);
  requireOwnKeys(db, session, card, route, args);
  const recipient = route.kind === "worker" ? workerOf(db, card.id) : route.to;
  const owes = args.reply === true ? owesOf(route, recipient, card) : {};
  let withdrawn: string[] = [];
  if (route.kind === "worker") {
    requireOpen(db, card);
    requireNotCaptains(db, card, args.resolves);
    withdrawn = withdrawMerge(db, card);
  }
  const delivered = recipient === undefined ? {} : { for: route.kind };
  const own = {
    resolves: args.resolves,
    now: args.now,
    withdraws: args.withdraws,
    ...delivered,
    ...owes,
  };
  const to = withEcho(db, session, card, recipient === undefined ? [] : [recipient]);
  const draft: Draft = {
    card: card.id,
    author: `mate:${session.lane}`,
    kind: "comment",
    body: args.text,
    fields: own,
  };
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
