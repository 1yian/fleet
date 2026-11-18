import type { DatabaseSync } from "node:sqlite";
import {
  check,
  OPERATION_RETIRED_SCRIPT,
  OPERATION_TREE_SCRIPT,
  OperationReceiptSchema,
  operationHandoff,
  OPS,
  parseOperationTree,
  type Card,
  type Entry,
} from "@fleet/protocol";
import { routed } from "@fleet/protocol/route";
import { runOnTransport } from "@fleet/protocol/transport";
import { routeFor } from "./merged-report.ts";
import type { Hosts } from "./pulls.ts";
import { addEntry, cardEntries, reachable, type Session } from "./store.ts";

const HOST_TIMEOUT_MS = 30_000;

interface Target {
  readonly session: string;
  readonly host: string;
  readonly clone: string;
  readonly branch: string;
  readonly base: string;
}

type Attempt = Target & { head: string; state: "clean" | "retired" };

export interface Receipt {
  readonly handoff: number;
  readonly attempts: Attempt[];
}

export interface Observed {
  readonly retired: readonly string[];
}

const keyOf = (target: Target): string =>
  [target.session, target.host, target.clone, target.branch, target.base].join("\n");

function targetsOf(db: DatabaseSync, card: Card): Target[] {
  const rows = db
    .prepare(
      `SELECT s.id AS session, a.host AS host, a.branch AS branch, coalesce(c.base_branch, p.default_base) AS base,
         json_extract(p.clones, '$."' || a.host || '"') AS clone
       FROM attempts a JOIN cards c ON c.id = a.card JOIN sessions s ON s.attempt = a.id
       LEFT JOIN projects p ON p.name = c.project
       WHERE a.card = ? ORDER BY a.n`,
    )
    .all(card.id);
  const targets = rows.map((row) => {
    const { session, host, branch, base, clone } = row;
    if (
      typeof session !== "string" ||
      typeof host !== "string" ||
      typeof branch !== "string" ||
      typeof base !== "string" ||
      typeof clone !== "string"
    )
      throw new Error(
        `c-${String(card.id)} cannot close Done: ${String(session)} has no registered clone on ${String(host)}`,
      );
    return { session, host, branch, base, clone };
  });
  if (targets.length === 0)
    throw new Error(`c-${String(card.id)} cannot close Done: it has no attempt to verify`);
  return targets;
}

function onHost(hosts: Hosts, host: string, argv: readonly string[]): Promise<string> {
  const [file = "sh", ...args] = routed(routeFor(hosts, host), argv);
  return new Promise((resolve, reject) => {
    runOnTransport(file, args, { timeout: HOST_TIMEOUT_MS }, (error, stdout) => {
      if (error === null) resolve(stdout);
      else reject(new Error("the host check failed", { cause: error }));
    });
  });
}

const treePath = (target: Target): string => `${target.clone}.worktrees/${target.session}`;

async function cleanHead(hosts: Hosts, target: Target): Promise<string | undefined> {
  try {
    const out = await onHost(hosts, target.host, [
      "sh",
      "-c",
      OPERATION_TREE_SCRIPT,
      "tree",
      treePath(target),
      target.clone,
      target.base,
      target.branch,
    ]);
    const found = parseOperationTree(out);
    return found.ahead === 0 && found.dirty === 0 ? found.head : undefined;
  } catch {
    return undefined;
  }
}

async function retired(hosts: Hosts, target: Target): Promise<boolean> {
  try {
    await onHost(hosts, target.host, [
      "sh",
      "-c",
      OPERATION_RETIRED_SCRIPT,
      "retired",
      treePath(target),
      target.clone,
      target.base,
      target.branch,
      target.session,
    ]);
    return true;
  } catch {
    return false;
  }
}

function openOperation(db: DatabaseSync, session: Session, id: number): Card {
  const { card } = reachable(db, session, id);
  if (card.delivery !== "ops" || card.status === "done" || card.status === "dropped")
    throw new Error(`c-${String(id)} is not an open ops card`);
  return card;
}

function handoffId(db: DatabaseSync, card: Card): number {
  const handoff = operationHandoff(cardEntries(db, card.id));
  if (handoff === undefined)
    throw new Error(`c-${String(card.id)} has no effective ops handoff to verify`);
  return handoff.id;
}

function latestReceipt(entries: readonly Entry[]): { entry: Entry; receipt: Receipt } | undefined {
  const entry = entries.findLast(
    (each) => each.author === "cardd" && each.fields["operationReceipt"] !== undefined,
  );
  if (entry === undefined) return undefined;
  return { entry, receipt: check(OperationReceiptSchema, entry.fields["operationReceipt"]) };
}

export async function checkReceipt(
  db: DatabaseSync,
  hosts: Hosts,
  session: Session,
  raw: unknown,
): Promise<Receipt> {
  const args = check(OPS["close.verify"].args, raw);
  const card = openOperation(db, session, args.card);
  const handoff = handoffId(db, card);
  if (handoff !== args.handoff)
    throw new Error(
      `c-${String(card.id)}: the worker's handoff changed while close was running. Close it again`,
    );
  const prior = latestReceipt(cardEntries(db, card.id));
  const earlier = prior?.receipt.handoff === handoff ? prior.receipt.attempts : [];
  const attempts: Attempt[] = [];
  const unresolved: string[] = [];
  for (const target of targetsOf(db, card)) {
    const head = await cleanHead(hosts, target);
    const was = earlier.find((each) => keyOf(each) === keyOf(target));
    if (head !== undefined) attempts.push({ ...target, head, state: "clean" });
    else if (was !== undefined && (await retired(hosts, target)))
      attempts.push({ ...target, head: was.head, state: "retired" });
    else unresolved.push(target.session);
  }
  if (unresolved.length > 0)
    throw new Error(
      `c-${String(card.id)} cannot close Done: ${unresolved.join(", ")} could not be verified clean or already retired, so nothing was removed`,
    );
  return { handoff, attempts };
}

export function recordReceipt(
  db: DatabaseSync,
  session: Session,
  raw: unknown,
  checked: Receipt | undefined,
): { receipt: number } {
  const args = check(OPS["close.verify"].args, raw);
  const card = openOperation(db, session, args.card);
  const targets = targetsOf(db, card).map(keyOf);
  const same =
    handoffId(db, card) === checked?.handoff &&
    targets.join("\n\n") === checked.attempts.map(keyOf).join("\n\n");
  if (checked === undefined || !same)
    throw new Error(
      `c-${String(card.id)}: the worker's handoff or the card's attempts changed while close was checking them. Close it again`,
    );
  const receipt = addEntry(
    db,
    {
      card: card.id,
      author: "cardd",
      kind: "note",
      body: "operation worktrees verified after the writers stopped",
      fields: { operationReceipt: checked },
    },
    [],
  );
  return { receipt };
}

export async function observeRetirement(
  db: DatabaseSync,
  hosts: Hosts,
  session: Session,
  raw: unknown,
): Promise<Observed | undefined> {
  const args = check(OPS["close.finish"].args, raw);
  if (args.mode !== "done") return undefined;
  const { card } = reachable(db, session, args.card);
  if (card.delivery !== "ops" || card.status === "done" || card.status === "dropped")
    return undefined;
  const done: string[] = [];
  for (const target of targetsOf(db, card))
    if (await retired(hosts, target)) done.push(keyOf(target));
  return { retired: done };
}

export function requireRetired(
  db: DatabaseSync,
  card: Card,
  handoff: number,
  observed: Observed | undefined,
): void {
  const found = latestReceipt(cardEntries(db, card.id));
  const targets = targetsOf(db, card);
  const held = found?.receipt.handoff === handoff ? found.receipt.attempts.map(keyOf) : [];
  const covered = (target: Target): boolean => held.includes(keyOf(target));
  const missing = targets.filter(
    (target) => !covered(target) || !observed?.retired.includes(keyOf(target)),
  );
  if (missing.length > 0)
    throw new Error(
      `c-${String(card.id)} cannot close Done: ${missing.map((each) => each.session).join(", ")} has no verified receipt for the current handoff and observed retirement. Close it with close(card, summary), which verifies and retires the worktrees first`,
    );
}
