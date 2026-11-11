import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isRecord } from "../lane-config.ts";
import { driftLine } from "./drift.ts";
import { gitOrNothing } from "./git.ts";
import { decide, resolved, skillFolders } from "./places.ts";
import { baseOf, standingOf, workshopOf } from "./scratch-tree.ts";
import type { World } from "./world.ts";

interface Winner {
  readonly name: string;
  readonly path: string;
}

const recordFile = (home: string): string => join(home, "state", "skills.json");

export function recordSkills(pi: ExtensionAPI, home: string): void {
  const skills = pi
    .getCommands()
    .filter((command) => command.source === "skill")
    .map((command) => ({
      name: command.name.replace(/^skill:/, ""),
      path: command.sourceInfo.path,
    }));
  mkdirSync(dirname(recordFile(home)), { recursive: true });
  writeFileSync(recordFile(home), JSON.stringify({ at: new Date().toISOString(), skills }));
}

function winners(home: string): Winner[] | undefined {
  try {
    const record: unknown = JSON.parse(readFileSync(recordFile(home), "utf8"));
    const listed = isRecord(record) && Array.isArray(record["skills"]) ? record["skills"] : [];
    return listed.flatMap((each: unknown) =>
      isRecord(each) && typeof each["name"] === "string" && typeof each["path"] === "string"
        ? [{ name: each["name"], path: each["path"] }]
        : [],
    );
  } catch {
    return undefined;
  }
}

function skillsIn(folder: string): Winner[] {
  if (!existsSync(folder)) return [];
  if (existsSync(join(folder, "SKILL.md")))
    return [{ name: basename(resolve(folder)), path: join(folder, "SKILL.md") }];
  return readdirSync(folder)
    .filter((name) => existsSync(join(folder, name, "SKILL.md")))
    .map((name) => ({ name, path: join(folder, name, "SKILL.md") }));
}

function candidateFolders(world: World): string[] {
  const args = world.lane.args.flatMap((arg, at) =>
    world.lane.args[at - 1] === "--skill" ? [arg] : [],
  );
  return [
    ...args,
    ...skillFolders(),
    join(world.home, ".pi", "skills"),
    join(world.home, "data", "skills"),
  ];
}

function access(world: World, path: string): string {
  const decision = decide(world, path);
  return decision.editable ? "writable" : `read-only, ${decision.why}`;
}

function skillLines(world: World, found: readonly Winner[]): string[] {
  const candidates = candidateFolders(world).flatMap(skillsIn);
  return found.flatMap((winner) => {
    const here = resolved(winner.path);
    const shadowed = candidates.filter(
      (other) => other.name === winner.name && resolved(other.path) !== here,
    );
    return [
      `${winner.name}: ${winner.path} [${access(world, winner.path)}]`,
      ...shadowed.map((other) => `  shadows: ${other.path} [${access(world, other.path)}]`),
    ];
  });
}

function workshopLines(world: World): string[] {
  const workshop = workshopOf(world);
  if (workshop === undefined) return [];
  const path = workshop.scratch;
  if (!existsSync(path)) return [`scratch: none yet, E makes ${path}`];
  const { branch, ahead, behind, dirty, merged } = standingOf(workshop.clone, path);
  const base = baseOf(workshop.clone);
  return [
    `scratch: ${path} on ${branch}, ${String(ahead)} ahead and ${String(behind)} behind ${base}, ${String(dirty)} dirty files`,
    ...(merged && ahead > 0
      ? ["flag: the scratch branch is merged, fleet files scratch reset"]
      : []),
    ...(behind > 0
      ? [`flag: the scratch is behind ${base}, so it hides newer released text from this lane`]
      : []),
  ];
}

function liveCheckoutFlags(): string[] {
  const [agents = "", piAgent = ""] = skillFolders();
  const user = existsSync(piAgent)
    ? readdirSync(piAgent).map(
        (name) => `flag: ${join(piAgent, name)} shadows the released skill of the same name here`,
      )
    : [];
  const live = existsSync(agents)
    ? readdirSync(agents).flatMap((name) => {
        const real = resolved(join(agents, name));
        const checkout = gitOrNothing(real, "rev-parse", "--show-toplevel");
        return checkout === undefined
          ? []
          : [`flag: ${join(agents, name)} resolves into the live checkout ${checkout}`];
      })
    : [];
  return [...user, ...live];
}

export function skillsTable(world: World): string[] {
  const found = winners(world.home);
  return [
    driftLine(world),
    ...workshopLines(world),
    ...liveCheckoutFlags(),
    ...(found === undefined
      ? [
          "no record yet: this lane's mate writes state/skills.json when it starts or reloads, so run this after it has started",
        ]
      : skillLines(world, found)),
  ];
}
