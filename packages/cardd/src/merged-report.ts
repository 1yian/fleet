import { execFile } from "node:child_process";
import type { DatabaseSync } from "node:sqlite";
import { hostname } from "node:os";
import { check, OPS, type OpArgs } from "@fleet/protocol";
import type { Hosts } from "./pulls.ts";
import { getCard, listProjects } from "./store.ts";

const quote = (arg: string): string => `'${arg.replaceAll("'", `'\\''`)}'`;

function routeFor(hosts: Hosts, host: string): readonly string[] {
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
  const [file = "direnv", ...args] =
    route.length === 0 ? command : [...route, command.map(quote).join(" ")];
  const out = await new Promise<string>((resolve, reject) => {
    execFile(file, args, { encoding: "utf8", timeout: 60_000 }, (error, stdout, stderr) => {
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
  const project = listProjects(db).find((each) => each.name === own.project);
  const latest = db
    .prepare("SELECT host FROM attempts WHERE card = ? ORDER BY n DESC LIMIT 1")
    .get(card);
  const place = project?.clones.find((clone) => clone.host === latest?.["host"]);
  if (place === undefined) return { note: "PR unknown: no project clone for this attempt" };
  try {
    return (await mergedOn(hosts, place, pr))
      ? { merged: true }
      : { note: `${pr} has not merged; the report counts as done` };
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    return { note: `PR unknown: ${why}. The report counts as done` };
  }
}

export async function normalizeReport(
  db: DatabaseSync,
  hosts: Hosts,
  card: number,
  raw: unknown,
): Promise<{ args: OpArgs<"report">; note?: string }> {
  const args = check(OPS.report.args, raw);
  if (args.status !== "merged") return { args };
  const { merged, note } = await verify(db, hosts, card, args.pr);
  return {
    args: { ...args, status: merged === true ? "merged" : "done", merged: merged === true },
    ...(note === undefined ? {} : { note }),
  };
}
