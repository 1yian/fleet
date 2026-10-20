// merge (spec sections 11.2 and 20.4): the guarded path. Authority first, then
// the PR's checks, then gh merges. The merge is recorded on the card, and the
// outcome goes to main.
import type { DatabaseSync } from "node:sqlite";
import { check, MERGE_OPTIONS, OPS, type Card } from "@fleet/protocol";
import { requireCaptainWords } from "./authority.ts";
import { applyChange } from "./change.ts";
import { mergePullRequest, readPullRequest } from "./github.ts";
import { answerHold, openMergeHold } from "./holds.ts";
import { factsFrom } from "./status.ts";
import {
  addEntry,
  cardEntries,
  getCard,
  mainLane,
  phaseOf,
  transaction,
  type Session,
} from "./store.ts";

interface Done {
  readonly value: unknown;
  readonly notify: readonly string[];
}

interface Approval {
  readonly hold: number;
  readonly words: string;
  readonly source: string;
}

interface Authorized {
  readonly card: Card & { pr: string };
  readonly approval: Approval | undefined;
}

/**
 * A card reaches Merging only through a grant that covers merging, or the captain's approval.
 * The captain already approved the latest merge question, even if another hold took the card
 * since. The approval still stands for this PR.
 */
const approvedOnRecord = (db: DatabaseSync, card: Card): boolean =>
  factsFrom(cardEntries(db, card.id)).mergeApproved;

/** A mate may merge its own lane's cards, and main may merge a second mate's. */
function requireLane(db: DatabaseSync, session: Session, card: Card): void {
  const parent = db.prepare("SELECT parent FROM lanes WHERE name = ?").get(card.lane)?.["parent"];
  if (card.lane !== session.lane && parent !== session.lane) {
    throw new Error(`c-${String(card.id)} belongs to lane ${card.lane}`);
  }
}

function authorize(db: DatabaseSync, session: Session, raw: unknown): Authorized {
  const args = check(OPS.merge.args, raw);
  const card = getCard(db, args.card);
  requireLane(db, session, card);
  if (card.pr === null) throw new Error(`c-${String(card.id)} has no PR`);
  const pr = { ...card, pr: card.pr };
  if (phaseOf(db, card.id) === "merging" || approvedOnRecord(db, card))
    return { card: pr, approval: undefined };
  const open = openMergeHold(db, card);
  if (open === undefined || args.words === undefined) {
    throw new Error(
      `no authority to merge c-${String(card.id)}: it needs a grant or the captain's approval`,
    );
  }
  const source = args.source ?? "record";
  requireCaptainWords(db, args.words, source);
  return { card: pr, approval: { hold: open.entry, words: args.words, source } };
}

export async function merge(db: DatabaseSync, session: Session, raw: unknown): Promise<Done> {
  const { card, approval } = transaction(db, () => authorize(db, session, raw));
  const pr = await readPullRequest(card.pr);
  if (pr.state === "CLOSED") throw new Error(`${card.pr} is closed`);
  if (pr.state === "OPEN") {
    if (pr.failed.length > 0) throw new Error(`checks failed: ${pr.failed.join(", ")}`);
    if (pr.pending.length > 0)
      throw new Error(`checks have not reported yet: ${pr.pending.join(", ")}`);
    await mergePullRequest(card.pr);
  }
  return transaction(db, () => {
    const now = getCard(db, card.id);
    const open = openMergeHold(db, now);
    const answered =
      approval !== undefined && open?.entry === approval.hold
        ? answerHold(db, session.lane, now, open, { ...approval, choice: MERGE_OPTIONS[0] })
        : undefined;
    if (answered === undefined && phaseOf(db, card.id) !== "merging")
      applyChange(db, now, { kind: "merged" });
    const main = mainLane(db);
    const to = main === card.lane ? [] : [main];
    const fields = { pr: card.pr, outcome: "merged" };
    addEntry(
      db,
      {
        card: card.id,
        author: `mate:${session.lane}`,
        kind: "merge",
        body: `merged ${card.pr}`,
        fields,
      },
      to,
    );
    return {
      value: getCard(db, card.id),
      notify: [...new Set([...to, ...(answered?.notify ?? [])])],
    };
  });
}
