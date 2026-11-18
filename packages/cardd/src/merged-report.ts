import type { DatabaseSync } from "node:sqlite";
import { hostname } from "node:os";
import { check, OPS, type Card, type Entry, type OpArgs } from "@fleet/protocol";
import { routed } from "@fleet/protocol/route";
import { runOnTransport } from "@fleet/protocol/transport";
import type { Hosts } from "./pulls.ts";
import { cardEntries, getCard, listProjects, reachable, type Session } from "./store.ts";
import { finishFrom } from "./status.ts";

export function routeFor(hosts: Hosts, host: string): readonly string[] {
  const configured = hosts[host];
  if (configured !== undefined) return configured;
  const local = hostname().toLowerCase();
  if (
    host === "local" ||
    host.toLowerCase() === local ||
    host.toLowerCase() === local.split(".")[0]
  )
    return [];
  throw new Error(`no host route configured for ${host}`);
}

function mergedState(out: string, url: string): boolean {
  const result: unknown = JSON.parse(out);
  if (typeof result !== "object" || result === null || !("state" in result))
    throw new Error("GitHub returned an unreadable PR");
  if (!("url" in result) || result.url !== url)
    throw new Error("GitHub returned a different PR URL");
  if (result.state !== "MERGED" && result.state !== "OPEN" && result.state !== "CLOSED")
    throw new Error("GitHub returned an unknown PR state");
  return result.state === "MERGED";
}

async function mergedOn(
  hosts: Hosts,
  place: { host: string; path: string },
  url: string,
): Promise<boolean> {
  const command = [
    "sh",
    "-c",
    'cd "$1" && shift && exec direnv exec . gh "$@"',
    "github",
    place.path,
    "pr",
    "view",
    url,
    "--json",
    "url,state",
  ];
  const route = routeFor(hosts, place.host);
  const [file = "direnv", ...args] = routed(route, command);
  const out = await new Promise<string>((resolve, reject) => {
    runOnTransport(file, args, { timeout: 60_000 }, (error, stdout, stderr) => {
      if (error !== null) reject(new Error(stderr.trim() || error.message));
      else resolve(stdout);
    });
  });
  return mergedState(out, url);
}

async function verify(
  db: DatabaseSync,
  hosts: Hosts,
  card: number,
  pr: string | undefined,
): Promise<{ merged?: true; note?: string }> {
  const own = getCard(db, card);
  if (own.kind !== "ship" || own.delivery === "local-only")
    return { note: "merged does not apply to this card; the report counts as done" };
  if (pr === undefined) return { note: "merged needs a PR URL; the report counts as done" };
  return checkPr(db, hosts, own, pr);
}

async function checkPr(
  db: DatabaseSync,
  hosts: Hosts,
  own: Card,
  pr: string,
): Promise<{ merged?: true; note?: string; unknown?: string }> {
  const card = own.id;
  const project = listProjects(db).find((each) => each.name === own.project);
  const latest = db
    .prepare("SELECT host FROM attempts WHERE card = ? ORDER BY n DESC LIMIT 1")
    .get(card);
  const place = project?.clones.find((clone) => clone.host === latest?.["host"]);
  if (place === undefined)
    return {
      note: "PR unknown: no project clone for this attempt",
      unknown: "no project clone for this attempt",
    };
  try {
    return (await mergedOn(hosts, place, pr))
      ? { merged: true }
      : { note: `${pr} has not merged; the report counts as done` };
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    return { note: `PR unknown: ${why}. The report counts as done`, unknown: why };
  }
}

export async function normalizeReport(
  db: DatabaseSync,
  hosts: Hosts,
  card: number,
  raw: unknown,
  session: string,
): Promise<{ args: OpArgs<"report">; note?: string }> {
  const args = check(OPS.report.args, raw);
  await requireOperationReport(db, hosts, getCard(db, card), args, session);
  if (args.status !== "merged") return { args };
  const { merged, note } = await verify(db, hosts, card, args.pr);
  return {
    args: { ...args, status: merged === true ? "merged" : "done", merged: merged === true },
    ...(note === undefined ? {} : { note }),
  };
}

async function requireOperationReport(
  db: DatabaseSync,
  hosts: Hosts,
  card: Card,
  args: OpArgs<"report">,
  session: string,
): Promise<void> {
  if (card.delivery !== "ops") return;
  if (args.status === "merged" || args.merged === true || args.pr !== undefined)
    throw new Error("ops work does not report a PR or merge; dispatch product changes separately");
  if (args.status !== "done") return;
  if (args.evidence === undefined)
    throw new Error(
      "ops completion requires evidence: an absolute report path outside the worktree",
    );
  if (!(await readableEvidence(db, hosts, card, session, args.evidence)))
    throw new Error(
      "ops completion evidence must be a readable report outside the worker's worktree",
    );
}

const CHECK_EVIDENCE = `
const { accessSync, constants, existsSync, realpathSync, statSync } = require('node:fs');
const { isAbsolute, resolve, sep } = require('node:path');
const [report, tree] = process.argv.slice(1);
const inside = (path, root) => path === root || path.startsWith(root + sep);
if (!isAbsolute(report) || inside(resolve(report), resolve(tree))) process.exit(1);
const file = realpathSync(report);
if (existsSync(tree) && inside(file, realpathSync(tree))) process.exit(1);
if (!statSync(file).isFile()) process.exit(1);
accessSync(file, constants.R_OK);
`;

async function readableEvidence(
  db: DatabaseSync,
  hosts: Hosts,
  card: Card,
  session: string,
  path: string,
): Promise<boolean> {
  const attempt = db
    .prepare(
      `SELECT a.host, a.n FROM attempts a JOIN sessions s ON s.attempt = a.id
              WHERE a.card = ? AND s.id = ?`,
    )
    .get(card.id, session);
  const host = attempt?.["host"];
  const n = attempt?.["n"];
  if (typeof host !== "string" || typeof n !== "number") return false;
  const clone = listProjects(db)
    .find((project) => project.name === card.project)
    ?.clones.find((place) => place.host === host);
  if (clone === undefined) return false;
  const tree = `${clone.path}.worktrees/c-${String(card.id)}-a${String(n)}`;
  try {
    const [file = "node", ...args] = routed(routeFor(hosts, host), [
      "node",
      "-e",
      CHECK_EVIDENCE,
      "--",
      path,
      tree,
    ]);
    return await new Promise((resolve) => {
      runOnTransport(file, args, { timeout: 30_000 }, (error) => {
        resolve(error === null);
      });
    });
  } catch {
    return false;
  }
}

export function latestOperationReport(entries: readonly Entry[]): Entry | undefined {
  return entries.findLast((entry) => entry.kind === "report" && entry.fields["status"] === "done");
}

async function verifyOperationAtClose(
  db: DatabaseSync,
  hosts: Hosts,
  card: Card,
): Promise<{ merged: false; checkedEvidence?: number }> {
  const entries = cardEntries(db, card.id);
  if (!finishFrom(entries).workerDone) return { merged: false };
  const report = latestOperationReport(entries);
  const evidence = report?.fields["evidence"];
  if (report === undefined || !report.author.startsWith("worker:") || typeof evidence !== "string")
    return { merged: false };
  const readable = await readableEvidence(
    db,
    hosts,
    card,
    report.author.slice("worker:".length),
    evidence,
  );
  return readable ? { merged: false, checkedEvidence: report.id } : { merged: false };
}

function unmergedShipPr(db: DatabaseSync, id: number): { card: Card; pr: string } | undefined {
  if (db.prepare("SELECT 1 FROM cards WHERE id = ?").get(id) === undefined) return undefined;
  const card = getCard(db, id);
  if (card.kind !== "ship" || card.delivery === "local-only" || card.pr === null) return undefined;
  return finishFrom(cardEntries(db, id)).merged ? undefined : { card, pr: card.pr };
}

export async function reverifyAtClose(
  db: DatabaseSync,
  hosts: Hosts,
  op: "close.begin" | "close.finish",
  raw: unknown,
  session: Session,
): Promise<{ merged: boolean; unknown?: string; checkedEvidence?: number }> {
  const args = check(OPS[op].args, raw);
  if ("mode" in args && args.mode !== "done") return { merged: false };
  const operation = db.prepare("SELECT 1 FROM cards WHERE id = ? AND delivery = 'ops'");
  if (operation.get(args.card) !== undefined) {
    if ("landed" in args && !args.landed) return { merged: false };
    const { card } = reachable(db, session, args.card);
    return verifyOperationAtClose(db, hosts, card);
  }
  const target = unmergedShipPr(db, args.card);
  if (target === undefined) return { merged: false };
  const { merged, unknown } = await checkPr(db, hosts, target.card, target.pr);
  if (merged === true) return { merged: true };
  return unknown === undefined ? { merged: false } : { merged: false, unknown };
}
