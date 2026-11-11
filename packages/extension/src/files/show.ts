import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { callCardd, carddHttp } from "../cardd-call.ts";
import { herdr } from "../host.ts";
import { gitOrNothing } from "./git.ts";
import { mainMate, ownMate, routeToMain, type Mate } from "./mates.ts";
import { resolved, skillRelative, under } from "./places.ts";
import { clearScreen, confirm, pressAnyKey } from "./prompt.ts";
import { scratchPath, workshopOf } from "./scratch-tree.ts";
import type { World } from "./world.ts";

export type Target = "lane" | "main";

const HASH_LENGTH = 12;
const STAT_LINES = 6;

const hashOf = (path: string): string =>
  createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, HASH_LENGTH);

function scratchFacts(world: World, real: string): string[] {
  const clone = world.clones.find((each) => under(real, resolved(scratchPath(each))));
  if (clone === undefined) return [];
  const root = scratchPath(clone);
  const branch = gitOrNothing(root, "rev-parse", "--abbrev-ref", "HEAD") ?? "unknown";
  const commit = gitOrNothing(root, "rev-parse", `--short=${String(HASH_LENGTH)}`, "HEAD") ?? "";
  const ahead = gitOrNothing(root, "rev-list", "--count", `origin/${clone.base}..HEAD`) ?? "0";
  const stat = (gitOrNothing(root, "diff", "--stat", "HEAD") ?? "")
    .split("\n")
    .filter(Boolean)
    .slice(0, STAT_LINES);
  return [
    `It is in the scratch worktree on branch ${branch} at commit ${commit}, ${ahead} commits ahead of origin/${clone.base}.`,
    ...(stat.length > 0 ? [`Uncommitted: ${stat.join("; ")}.`] : []),
  ];
}

function skillFacts(world: World, path: string, target: Target): string[] {
  const workshop = workshopOf(world);
  const real = resolved(path);
  if (workshop !== undefined && under(real, resolved(workshop.skills)))
    return ["It is a skill in the scratch: re-read it before you use it."];
  const inside = skillRelative(path);
  if (inside === undefined) return [];
  const name = inside.split("/")[0] ?? "";
  return target === "main"
    ? [`This is a skill request for ${name}, whose released copy this is.`]
    : [];
}

function lineRange(lines: string | undefined): string[] {
  if (lines === undefined) return [];
  if (!/^\d+(-\d+)?$/.test(lines)) throw new Error("fleet files show: --lines takes 12 or 12-20");
  return [`Lines ${lines}.`];
}

function showText(
  world: World,
  target: Target,
  path: string,
  lines?: string,
): { readonly text: string; readonly what: string } {
  if (!existsSync(path)) throw new Error(`fleet files show: ${path} does not exist`);
  const real = resolved(path);
  const kind = statSync(real).isDirectory() ? "folder" : "file";
  const hash = kind === "file" ? `, sha256 ${hashOf(real)}` : "";
  const origin =
    target === "main"
      ? `From the ${world.lane.lane} lane's Files tab on ${world.host}:`
      : `From this lane's Files tab on ${world.host}:`;
  const facts = [
    `${origin} look at the ${kind} ${path}${hash}.`,
    ...lineRange(lines),
    ...scratchFacts(world, real),
    ...skillFacts(world, path, target),
  ];
  return {
    text: facts.join(" "),
    what: `${basename(path)} to ${target === "main" ? "main" : "this lane's mate"}`,
  };
}

async function typeInto(mate: Mate, text: string): Promise<string> {
  if (mate.status === "blocked")
    throw new Error(
      `the mate of lane ${mate.lane} is blocked, waiting on a dialog, so nothing was typed. Answer it first`,
    );
  await herdr(mate.host, ["agent", "prompt", mate.agent, text]);
  return `typed into the pane of the ${mate.lane} mate on ${mate.host}`;
}

async function boardComment(world: World, text: string, why: string): Promise<string> {
  const cards = await callCardd(world.lane, "board", {});
  const open = cards
    .filter(
      (card) =>
        card.lane === world.lane.lane && card.status !== "done" && card.status !== "dropped",
    )
    .sort((a, b) => b.id - a.id)[0];
  if (open === undefined)
    throw new Error(
      `main is not reachable from here (${why}), and lane ${world.lane.lane} has no open card to comment on`,
    );
  const response = await fetch(carddHttp(world.lane, "/api/action"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ card: open.id, action: { kind: "comment", text } }),
  });
  if (!response.ok)
    throw new Error(
      `the board refused the comment on c-${String(open.id)}: ${await response.text()}`,
    );
  return `main is not reachable from here (${why}), so this went to main as a comment on c-${String(open.id)}`;
}

async function deliver(world: World, target: Target, text: string): Promise<string> {
  if (target === "lane") return typeInto(await ownMate(world), text);
  const route = routeToMain(world);
  if (route.kind === "board") return boardComment(world, text, route.why);
  return typeInto(await mainMate(route.host), text);
}

async function finish(run: () => Promise<string>): Promise<number> {
  clearScreen();
  try {
    console.log(await run());
    await pressAnyKey();
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    await pressAnyKey();
    return 1;
  }
}

export function show(world: World, target: Target, path: string, lines?: string): Promise<number> {
  return finish(async () => {
    const { text, what } = showText(world, target, path, lines);
    console.log(text);
    const note = await confirm(`Enter sends ${what}, Esc cancels.`, true);
    if (note === undefined) return "cancelled, nothing was typed";
    return deliver(world, target, note === "" ? text : `${text} ${note}`);
  });
}

export function reload(world: World, target: Target): Promise<number> {
  return finish(async () => {
    const route = target === "main" ? routeToMain(world) : undefined;
    if (route?.kind === "board") throw new Error(`cannot reload main from here: ${route.why}`);
    const mate = route === undefined ? await ownMate(world) : await mainMate(route.host);
    if (mate.status !== "idle")
      throw new Error(
        `the ${mate.lane} mate is ${mate.status}, and Pi can only reload when it is idle. Nothing was typed`,
      );
    const note = await confirm(
      `Enter types /reload into the ${mate.lane} mate, Esc cancels.`,
      false,
    );
    if (note === undefined) return "cancelled, nothing was typed";
    return typeInto(mate, "/reload");
  });
}
