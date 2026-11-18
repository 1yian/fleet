import type { DatabaseSync } from "node:sqlite";
import {
  check,
  OPERATION_TREE_SCRIPT,
  OPS,
  OperationVerifiedSchema,
  operationHandoff,
  parseOperationTree,
  type Card,
  type Entry,
  type OperationVerified,
} from "@fleet/protocol";
import { routed } from "@fleet/protocol/route";
import { runOnTransport } from "@fleet/protocol/transport";
import { routeFor } from "./merged-report.ts";
import type { Hosts } from "./pulls.ts";
import { addEntry, cardEntries, reachable, type Session } from "./store.ts";

const TREE_TIMEOUT_MS = 30_000;

export interface TreeCheck {
  readonly session: string;
  readonly head: string | null;
  readonly clean: boolean;
  readonly problem: string | null;
}

function runTreeCheck(hosts: Hosts, host: string, argv: readonly string[]): Promise<string> {
  const [file = "sh", ...args] = routed(routeFor(hosts, host), argv);
  return new Promise((resolve, reject) => {
    runOnTransport(file, args, { timeout: TREE_TIMEOUT_MS }, (error, stdout) => {
      if (error === null) resolve(stdout);
      else reject(new Error("the worktree check failed", { cause: error }));
    });
  });
}

const plural = (count: number, one: string): string =>
  `${String(count)} ${one}${count === 1 ? "" : "s"}`;

async function checkTree(
  hosts: Hosts,
  row: { session: string; host: string; clone: string; base: string },
): Promise<TreeCheck> {
  const worktree = `${row.clone}.worktrees/${row.session}`;
  try {
    const found = parseOperationTree(
      await runTreeCheck(hosts, row.host, [
        "sh",
        "-c",
        OPERATION_TREE_SCRIPT,
        "tree",
        worktree,
        row.clone,
        row.base,
      ]),
    );
    const parts = [
      found.ahead > 0 ? `${plural(found.ahead, "commit")} not on ${row.base}` : "",
      found.dirty > 0 ? plural(found.dirty, "uncommitted file") : "",
    ].filter((part) => part !== "");
    const clean = parts.length === 0;
    return {
      session: row.session,
      head: found.head,
      clean,
      problem: clean ? null : parts.join(" and "),
    };
  } catch {
    return { session: row.session, head: null, clean: false, problem: "could not be checked" };
  }
}

export async function operationTrees(
  db: DatabaseSync,
  hosts: Hosts,
  session: Session,
  op: string,
  raw: unknown,
): Promise<{ trees?: TreeCheck[] }> {
  if (op !== "close.begin") return {};
  const args = check(OPS["close.begin"].args, raw);
  const ops = db.prepare("SELECT 1 FROM cards WHERE id = ? AND delivery = 'ops'").get(args.card);
  if (args.landed === false || ops === undefined) return {};
  const { card } = reachable(db, session, args.card);
  if (card.status === "done" || card.status === "dropped") return {};
  return { trees: await checkOperationTrees(db, hosts, card) };
}

async function checkOperationTrees(
  db: DatabaseSync,
  hosts: Hosts,
  card: Card,
): Promise<TreeCheck[]> {
  const rows = db
    .prepare(
      `SELECT s.id AS session, a.host AS host, coalesce(c.base_branch, p.default_base) AS base,
         json_extract(p.clones, '$."' || a.host || '"') AS clone
       FROM attempts a JOIN cards c ON c.id = a.card JOIN sessions s ON s.attempt = a.id
       LEFT JOIN projects p ON p.name = c.project
       WHERE a.card = ? ORDER BY a.n`,
    )
    .all(card.id);
  const found: TreeCheck[] = [];
  for (const { session, host, base, clone } of rows) {
    found.push(
      typeof session === "string" &&
        typeof host === "string" &&
        typeof base === "string" &&
        typeof clone === "string"
        ? await checkTree(hosts, { session, host, base, clone })
        : {
            session: String(session),
            head: null,
            clean: false,
            problem: "has no registered clone on its host",
          },
    );
  }
  return found;
}

export function recordOperationTrees(
  db: DatabaseSync,
  card: Card,
  trees: readonly TreeCheck[],
): string[] {
  const verified: OperationVerified = trees.map(({ session, head, clean }) => ({
    session,
    head,
    clean,
  }));
  const state = trees.every((tree) => tree.clean) ? "clean" : "not clean";
  addEntry(
    db,
    {
      card: card.id,
      author: "cardd",
      kind: "note",
      body: `operation worktrees checked before close: ${state}`,
      fields: { operationVerified: verified },
    },
    [],
  );
  return trees.filter((tree) => !tree.clean).map((tree) => `${tree.session} ${tree.problem ?? ""}`);
}

export function operationHandoffOf(
  db: DatabaseSync,
  card: Card,
): { entry: Entry; session: string; evidence: string } {
  const entry = operationHandoff(cardEntries(db, card.id));
  const evidence = entry?.fields["evidence"];
  if (entry === undefined || typeof evidence !== "string")
    throw new Error(
      `c-${String(card.id)} cannot close Done: its worker has not handed back ops completion evidence`,
    );
  return { entry, session: entry.author.slice("worker:".length), evidence };
}

export function requireVerified(db: DatabaseSync, card: Card, handoff: Entry): void {
  const record = cardEntries(db, card.id).findLast(
    (entry) =>
      entry.kind === "note" && entry.author === "cardd" && "operationVerified" in entry.fields,
  );
  const sessions = db
    .prepare(
      "SELECT s.id AS id FROM attempts a JOIN sessions s ON s.attempt = a.id WHERE a.card = ?",
    )
    .all(card.id)
    .map((row) => String(row["id"]));
  const verified =
    record === undefined ? [] : check(OperationVerifiedSchema, record.fields["operationVerified"]);
  const covered = sessions.every((session) =>
    verified.some((each) => each.session === session && each.clean),
  );
  if (record === undefined || record.id < handoff.id || sessions.length === 0 || !covered)
    throw new Error(
      `c-${String(card.id)} cannot close Done: no clean check of every attempt's worktree is recorded after the worker's handoff. Close it with close(card, summary), which checks them first`,
    );
}
