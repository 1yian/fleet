// merge (spec sections 11.2 and 20.4): the guarded path. Authority first, then
// the PR's checks, then gh merges. The merge is recorded on the card, and the
// outcome goes to main.
import type { DatabaseSync } from "node:sqlite";
import { check, OPS, type Card } from "@fleet/protocol";
import { requireCaptainWords } from "./authority.ts";
import { applyChange } from "./change.ts";
import { mergePullRequest, readPullRequest } from "./github.ts";
import { addEntry, getCard, mainLane, transaction, type Session } from "./store.ts";

interface Done {
  readonly value: unknown;
  readonly notify: readonly string[];
}

/**
 * A card reaches Merging only through a grant that covers merging, or the
 * captain's approval. On a card that waits for that approval, the captain's
 * quoted words can authorize the merge directly.
 */
function authorize(db: DatabaseSync, session: Session, raw: unknown): Card & { pr: string } {
  const args = check(OPS.merge.args, raw);
  const card = getCard(db, args.card);
  const parent = db.prepare("SELECT parent FROM lanes WHERE name = ?").get(card.lane)?.["parent"];
  if (card.lane !== session.lane && parent !== session.lane)
    throw new Error(`c-${String(card.id)} belongs to lane ${card.lane}`);
  if (card.pr === null) throw new Error(`c-${String(card.id)} has no PR`);
  if (card.status !== "merging") {
    if (card.status !== "needs-you" || args.words === undefined) {
      throw new Error(
        `no authority to merge c-${String(card.id)}: it needs a grant or the captain's approval`,
      );
    }
    requireCaptainWords(db, args.words, args.source ?? "record");
  }
  return { ...card, pr: card.pr };
}

export async function merge(db: DatabaseSync, session: Session, raw: unknown): Promise<Done> {
  const card = transaction(db, () => authorize(db, session, raw));
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
    if (now.status !== "merging") applyChange(db, now, { kind: "merged" });
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
    return { value: getCard(db, card.id), notify: to };
  });
}
