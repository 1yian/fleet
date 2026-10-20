// Holds (spec section 17). A card has at most one hold: the gate it waits at, with every
// question of the gate bundled in it. The card's own mate owns it, and it names who it waits
// on now: the mate, then main, then the captain. The owner resolves it or escalates it one
// level. Only main marks a hold as the captain's. The owner releases it, with the captain's
// exact words when he decided it.
import type { DatabaseSync } from "node:sqlite";
import { check, MERGE_OPTIONS, OPS, type Card, type Holder } from "@fleet/protocol";
import { effectiveGrant, requireCaptainWords } from "./authority.ts";
import { applyChange, settle, type Draft } from "./change.ts";
import { withEcho } from "./echo.ts";
import { factsFrom, type Facts, type Hold } from "./status.ts";
import {
  addEntry,
  cardEntries,
  getCard,
  parentOf,
  reachable,
  touchCard,
  type Session,
} from "./store.ts";

interface Done {
  readonly value: unknown;
  readonly notify: readonly string[];
}

/** The card's open hold, if it has one. */
export function holdOf(db: DatabaseSync, card: Card): Hold | undefined {
  return factsFrom(cardEntries(db, card.id)).hold;
}

/** The card's open merge hold, if the merge question is what it waits at. */
export function openMergeHold(db: DatabaseSync, card: Card): Hold | undefined {
  const hold = holdOf(db, card);
  return hold?.merge === true ? hold : undefined;
}

/** The lane that acts when a hold waits on this holder. The captain is not a session. */
function laneOf(db: DatabaseSync, card: Card, holder: Holder): string | undefined {
  if (holder === "owner") return card.lane;
  return holder === "main" ? (parentOf(db, card.lane) ?? card.lane) : undefined;
}

/** The sessions to tell of a change to a card's hold: the owner, and main when the hold left the owner. Never the one that made it. */
export function hearers(
  db: DatabaseSync,
  card: Card,
  actor: string | null,
  through: readonly Holder[],
): string[] {
  const lanes = [card.lane, ...through.map((holder) => laneOf(db, card, holder))];
  return [...new Set(lanes.filter((lane): lane is string => lane !== undefined && lane !== actor))];
}

/** The levels a hold of this card climbs: its owner, main, then the captain. Main's own cards skip main. */
function levelsOf(db: DatabaseSync, card: Card): readonly Holder[] {
  return parentOf(db, card.lane) === null ? ["owner", "captain"] : ["owner", "main", "captain"];
}

/** Who a hold waits on once this call has run: a new hold waits on the next level up, an open one stays unless it climbs. */
function targetOf(levels: readonly Holder[], current: Holder, to: Holder | undefined): Holder {
  if (to !== undefined) return to;
  return current === "owner" ? (levels[1] ?? current) : current;
}

/** A hold climbs one level at a time, and only main marks it as the captain's. */
function requireClimb(
  db: DatabaseSync,
  session: Session,
  card: Card,
  current: Holder,
  target: Holder,
): void {
  const name = `c-${String(card.id)}`;
  const levels = levelsOf(db, card);
  if (!levels.includes(target))
    throw new Error(`${name} is in main's own lane, so its hold waits on the captain, not main`);
  const climb = levels.indexOf(target) - levels.indexOf(current);
  if (climb < 0)
    throw new Error(`${name} waits on ${current}; a hold climbs one level, never down`);
  if (climb > 1) throw new Error(`${name} waits on ${current}; escalate it one level at a time`);
  if (climb === 1 && target === "captain" && parentOf(db, session.lane) !== null)
    throw new Error("only main marks a hold as the captain's: escalate it to main");
}

/** Main escalates the hold that a lane's mate escalated to it. It never opens one in a lane, and never takes one from its mate. */
function requireMainsHold(card: Card, own: boolean, open: Hold | undefined): void {
  if (!own && (open === undefined || open.holder === "owner"))
    throw new Error(
      `c-${String(card.id)} has no hold with main; its mate resolves it or escalates it first`,
    );
}

/** Whether writing the hold again would change nothing. */
function isSame(
  open: Hold | undefined,
  next: { holder: Holder; question: string; until: number | null; options: readonly string[] },
): boolean {
  return (
    open?.holder === next.holder &&
    open.question === next.question &&
    open.until === next.until &&
    open.options.join("\n") === next.options.join("\n")
  );
}

/** The hold as it will be written again: the holder, the options, and the merge kind that it has now. */
export function rewritten(
  facts: Facts,
  holder: Holder,
  until: number | undefined,
): {
  holder: Holder;
  options: readonly string[];
  merge: boolean;
  until: number | null;
  occurrence: number;
} {
  const open = facts.hold;
  return {
    holder,
    options: open?.options ?? [],
    merge: open?.merge ?? false,
    until: until ?? null,
    occurrence: open?.occurrence ?? facts.occurrences + 1,
  };
}

/**
 * Holds the card, or holds it again. The hold is one per card, so a second call is the same
 * hold written again, and one after a release is its next occurrence. A mate that owns the
 * card escalates it to main. Main escalates what the owner escalated to it, to the captain.
 */
export function hold(db: DatabaseSync, session: Session, raw: unknown): Done {
  const args = check(OPS.hold.args, raw);
  const { card, own } = reachable(db, session, args.card);
  if (args.until !== undefined && args.until <= Date.now())
    throw new Error("until must be in the future");
  const facts = factsFrom(cardEntries(db, card.id));
  const open = facts.hold;
  requireMainsHold(card, own, open);
  const current = open?.holder ?? "owner";
  const target = targetOf(levelsOf(db, card), current, args.to);
  requireClimb(db, session, card, current, target);
  const base = rewritten(facts, target, args.until);
  const options = args.options ?? base.options;
  if (isSame(open, { holder: target, question: args.question, until: base.until, options }))
    return { value: card, notify: [] };
  // A hold that was open and now waits higher is escalated: the one hold climbs, and none is added.
  const escalated = open !== undefined && target !== current;
  const fields = { ...base, options, ...(escalated ? { escalated } : {}) };
  const draft: Draft = {
    card: card.id,
    author: `mate:${session.lane}`,
    kind: "hold",
    body: args.question,
    fields,
  };
  applyChange(db, card, { kind: "held" }, [draft]);
  const echoed = withEcho(db, session, card, hearers(db, card, session.lane, [target]), fields);
  addEntry(db, { ...draft, fields: echoed.fields }, echoed.to);
  touchCard(db, card.id);
  return { value: getCard(db, card.id), notify: echoed.to };
}

/** The captain's choice on a merge hold: approve or request changes. */
function mergeOutcome(choice: string | undefined): "approve" | "changes" {
  const [approve, changes] = MERGE_OPTIONS;
  if (choice === approve) return "approve";
  if (choice === changes) return "changes";
  throw new Error(`a merge question needs the choice "${approve}" or "${changes}"`);
}

/**
 * Releases the hold with the captain's exact words: the captain decided it. `actor` is the lane
 * of the mate that records them, or null for the board. The owner hears, and so does main.
 */
export function answerHold(
  db: DatabaseSync,
  actor: string | null,
  card: Card,
  open: Hold,
  args: {
    readonly words: string;
    readonly source: string;
    readonly choice?: string | undefined;
    readonly written?: boolean;
  },
): Done {
  const outcome = open.merge ? mergeOutcome(args.choice) : undefined;
  const fields = {
    hold: open.entry,
    occurrence: open.occurrence,
    source: args.source,
    by: actor === null ? "board" : `mate:${actor}`,
    choice: args.choice,
    ...(args.written === true ? { written: true } : {}),
  };
  const draft: Draft = {
    card: card.id,
    author: "captain",
    kind: "answer",
    body: args.words,
    fields,
  };
  applyChange(db, card, { kind: "released", ...(outcome === undefined ? {} : { outcome }) }, [
    draft,
  ]);
  const to = hearers(db, card, actor, ["main"]);
  addEntry(db, draft, to);
  touchCard(db, card.id);
  return { value: getCard(db, card.id), notify: [...to, ...askAgain(db, card)] };
}

/**
 * Releases the card's hold. With the captain's exact words, the captain decided it, and merge
 * approval is such a release. With a note, the mate or main decided it: the owner resolves what
 * waits on it, and main resolves what the owner escalated to it. Only the captain's words
 * release what waits on the captain.
 */
export function release(db: DatabaseSync, session: Session, raw: unknown): Done {
  const args = check(OPS.release.args, raw);
  const { card, own } = reachable(db, session, args.card);
  const name = `c-${String(card.id)}`;
  const open = holdOf(db, card);
  if (open === undefined) throw new Error(`${name} has no open hold`);
  if ((args.words === undefined) === (args.note === undefined))
    throw new Error("release needs the captain's exact words, or your own note, and not both");
  if (args.words !== undefined) {
    const source = args.source ?? "record";
    requireCaptainWords(db, args.words, source);
    return answerHold(db, session.lane, card, open, { ...args, words: args.words, source });
  }
  if (open.holder === "captain" || open.merge)
    throw new Error(`${name} waits on the captain: release it with his exact words`);
  if (!own && open.holder !== "main")
    throw new Error(`${name} waits on ${card.lane}'s mate, who resolves it or escalates it`);
  const fields = { hold: open.entry, occurrence: open.occurrence };
  const body = args.note ?? "";
  const draft: Draft = {
    card: card.id,
    author: `mate:${session.lane}`,
    kind: "release",
    body,
    fields,
  };
  applyChange(db, card, { kind: "released" }, [draft]);
  const echoed = withEcho(
    db,
    session,
    card,
    hearers(db, card, session.lane, [open.holder]),
    fields,
  );
  addEntry(db, { ...draft, fields: echoed.fields }, echoed.to);
  touchCard(db, card.id);
  return { value: getCard(db, card.id), notify: [...echoed.to, ...askAgain(db, card)] };
}

/**
 * Withdraws the merge question while the PR is reworked: approving a PR that is about to change
 * would approve the wrong head. The worker's next `done` asks again, as the same hold.
 */
export function withdrawMerge(
  db: DatabaseSync,
  card: Card,
  why: "reworked" | "closed" | "merged" = "reworked",
): string[] {
  const open = openMergeHold(db, card);
  if (open === undefined) return [];
  const body = {
    reworked:
      "The PR is being reworked, so the merge question is withdrawn. It is asked again when the work is done.",
    closed: "The PR was closed without a merge, so the merge question is withdrawn.",
    merged: "The PR merged on GitHub, so the merge question is moot and withdrawn.",
  }[why];
  const fields = { hold: open.entry, occurrence: open.occurrence, withdrawn: true };
  const draft: Draft = { card: card.id, author: "fleet", kind: "release", body, fields };
  applyChange(db, card, { kind: "released", outcome: "withdrawn" }, [draft]);
  const to = hearers(db, card, null, [open.holder]);
  addEntry(db, draft, to);
  touchCard(db, card.id);
  return to;
}

/**
 * The merge question of a ship card that is done without a grant for merging (spec section
 * 7.5), as the hold it would write, or undefined when none is due. The question is a hold of
 * the card. It waits on main, which escalates it, or on the captain when main owns the card.
 * It needs the PR, and it is not asked while another hold is open or while approval stands.
 * `pending` are the entries that the caller writes before it.
 */
export function mergeQuestion(
  db: DatabaseSync,
  card: Card,
  pending: readonly Draft[],
): Draft | undefined {
  const written = pending.map((draft) => ({ ...draft, id: 0, createdAt: 0 }));
  const facts = factsFrom([...cardEntries(db, card.id), ...written]);
  if (card.kind !== "ship" || card.pr === null || !facts.awaitingMerge) return undefined;
  if (facts.hold !== undefined || facts.mergeApproved) return undefined;
  if (effectiveGrant(db, card.id, Date.now())?.merge === true) return undefined;
  const holder: Holder = levelsOf(db, card).includes("main") ? "main" : "captain";
  const fields = {
    holder,
    options: [...MERGE_OPTIONS],
    merge: true,
    until: null,
    occurrence: facts.occurrences + 1,
    pr: card.pr,
  };
  const body = `Merge ${card.pr} for c-${String(card.id)}: ${card.title}?`;
  return { card: card.id, author: "fleet", kind: "hold", body, fields };
}

/** A release can leave a finished PR with no hold. Then the merge question is asked again. */
function askAgain(db: DatabaseSync, card: Card): string[] {
  const question = mergeQuestion(db, card, []);
  return question === undefined ? [] : writeMergeQuestion(db, getCard(db, card.id), question);
}

/** Writes the merge question that `mergeQuestion` found. Returns the sessions to tell: main, when main must escalate it. */
export function writeMergeQuestion(db: DatabaseSync, card: Card, question: Draft): string[] {
  const toMain = question.fields["holder"] === "main";
  const to = toMain ? hearers(db, card, null, ["main"]).filter((lane) => lane !== card.lane) : [];
  addEntry(db, question, to);
  settle(db, card.id, Date.now());
  touchCard(db, card.id);
  return to;
}
