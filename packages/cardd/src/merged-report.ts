import type { DatabaseSync } from "node:sqlite";
import { hostname } from "node:os";
import { check, evidenceScope, OPS, type Card, type OpArgs } from "@fleet/protocol";
import { routed } from "@fleet/protocol/route";
import { runOnTransport } from "@fleet/protocol/transport";
import type { Hosts } from "./pulls.ts";
import { cardEntries, getCard, listProjects } from "./store.ts";
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
): Promise<{ args: OpArgs<"report">; note?: string }> {
  const args = check(OPS.report.args, raw);
  requireOperationEvidence(getCard(db, card), args);
  if (args.status !== "merged") return { args };
  const { merged, note } = await verify(db, hosts, card, args.pr);
  return {
    args: { ...args, status: merged === true ? "merged" : "done", merged: merged === true },
    ...(note === undefined ? {} : { note }),
  };
}

function requireOperationEvidence(card: Card, args: OpArgs<"report">): void {
  if (card.delivery !== "ops") {
    if (args.evidence !== undefined)
      throw new Error("evidence is only for the done report of an ops card");
    return;
  }
  if (args.status === "merged" || args.merged === true || args.pr !== undefined)
    throw new Error("ops work does not report a PR or merge; dispatch product changes separately");
  if (args.status !== "done") {
    if (args.evidence !== undefined)
      throw new Error("evidence is only for the done report of an ops card");
    return;
  }
  if (args.evidence === undefined)
    throw new Error(
      "ops completion requires evidence: an absolute path to a report in $FLEET_SCRATCH",
    );
  if (evidenceScope(card.id, args.evidence) === undefined)
    throw new Error(
      "ops evidence must be a file in this card's $FLEET_SCRATCH folder, outside its tmp folder",
    );
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
): Promise<{ merged: boolean; unknown?: string }> {
  const args = check(OPS[op].args, raw);
  if ("mode" in args && args.mode !== "done") return { merged: false };
  const target = unmergedShipPr(db, args.card);
  if (target === undefined) return { merged: false };
  const { merged, unknown } = await checkPr(db, hosts, target.card, target.pr);
  if (merged === true) return { merged: true };
  return unknown === undefined ? { merged: false } : { merged: false, unknown };
}
