import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Entry } from "@fleet/protocol";
import { viewerBuild } from "@fleet/protocol/build";
import { quote } from "@fleet/protocol/route";
import { viewerArguments, type Source } from "./browser-access.ts";
import { field, herdr, paneText, records, rootPane, shellIdle } from "./host.ts";
import type { Link } from "./link.ts";

const VIEWER = fileURLToPath(new URL("./browser-view.ts", import.meta.url));
const BROWSER_TAB = "Browser";
const VIEWER_LINE = /Fleet browser viewer \((captain|gated)\): (\S+)/g;
const BUILD_LINE = /^Viewer build: (\w+)$/m;
const LAUNCH_LINE = /^Viewer launch: (\w+)$/m;
const MODE_WAIT_MS = 5_000;
const STOP_WAIT_MS = 15_000;
const LINK_WAIT_MS = 15_000;
const SUMMON_WAIT_MS = 45_000;
const POLL_MS = 100;

export interface Placement {
  readonly workspace: string;
  readonly cwd: string;
  readonly source: Source;
  readonly open: boolean;
  readonly focus: boolean;
  readonly captain: boolean;
  readonly held: () => Promise<boolean>;
}

export interface Placed {
  readonly started: boolean;
  readonly link: string | undefined;
}

export async function openSheprd(url: string): Promise<boolean> {
  const bin = join(homedir(), ".local/state/herdr/gpui/bin");
  const shim = ["sheprd", "herdr-gpui"].map((name) => join(bin, name)).find(existsSync);
  if (shim === undefined) return false;
  try {
    await promisify(execFile)(shim, ["browser", "open", "--tab", url], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

async function paneOf(workspace: string, tab: string): Promise<string | undefined> {
  const panes = records(
    (await herdr("local", ["pane", "list", "--workspace", workspace]))["panes"],
  );
  return field(
    panes.find((each) => each["tab_id"] === tab),
    "pane_id",
  );
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function until(done: () => Promise<boolean>, waitMs: number): Promise<boolean> {
  const deadline = Date.now() + waitMs;
  while (!(await done())) {
    if (Date.now() > deadline) return false;
    await sleep(POLL_MS);
  }
  return true;
}

interface Printed {
  readonly mode: "captain" | "gated";
  readonly link: string;
  readonly build: string | undefined;
  readonly launch: string | undefined;
}

async function printedViewer(pane: string): Promise<Printed | undefined> {
  const text = await paneText("local", pane);
  const last = [...text.matchAll(VIEWER_LINE)].at(-1);
  if (last === undefined) return undefined;
  const after = text.slice(last.index + last[0].length);
  return {
    mode: last[1] === "captain" ? "captain" : "gated",
    link: last[2] ?? "",
    build: BUILD_LINE.exec(after)?.[1],
    launch: LAUNCH_LINE.exec(after)?.[1],
  };
}

async function runningViewer(pane: string): Promise<Printed | undefined> {
  let printed: Printed | undefined;
  await until(async () => {
    printed = await printedViewer(pane);
    return printed !== undefined || (await shellIdle("local", pane));
  }, MODE_WAIT_MS);
  return printed;
}

async function stop(pane: string): Promise<void> {
  await herdr("local", ["pane", "send-keys", pane, "ctrl+c"]);
  if (!(await until(() => shellIdle("local", pane), STOP_WAIT_MS)))
    throw new Error("the viewer in the Browser tab did not stop, so a new viewer was not started");
}

async function replaceable(placement: Placement, running: Printed): Promise<boolean> {
  if (placement.captain) return running.mode !== "captain" || running.build !== viewerBuild();
  return (
    running.mode === "gated" &&
    running.build !== viewerBuild() &&
    !(await placement.held().catch(() => true))
  );
}

async function startable(placement: Placement, pane: string): Promise<boolean> {
  if (await shellIdle("local", pane)) return true;
  const running = await runningViewer(pane);
  if (running === undefined || !(await replaceable(placement, running))) return false;
  await stop(pane);
  return true;
}

async function linkOf(
  placement: Placement,
  pane: string | undefined,
  launched: string | undefined,
): Promise<string | undefined> {
  if (!placement.captain || pane === undefined) return undefined;
  let link: string | undefined;
  await until(async () => {
    const printed = await printedViewer(pane);
    const mine =
      launched === undefined ? printed?.build === viewerBuild() : printed?.launch === launched;
    link = printed?.mode === "captain" && mine ? printed.link : undefined;
    return link !== undefined;
  }, LINK_WAIT_MS);
  return link;
}

const commandFor = ({ source, open, captain }: Placement, marker: string): string =>
  `node ${quote(VIEWER)} ${viewerArguments(source).map(quote).join(" ")}${open ? " --open" : ""}${captain ? " --captain" : ""} --launch ${marker}`;

async function launch(placement: Placement, pane: string): Promise<string> {
  const marker = randomBytes(8).toString("hex");
  await herdr("local", ["pane", "run", pane, commandFor(placement, marker)]);
  return marker;
}

async function create(placement: Placement): Promise<string> {
  const { workspace, cwd, focus } = placement;
  const created = await herdr("local", [
    "tab",
    "create",
    "--workspace",
    workspace,
    "--cwd",
    cwd,
    "--label",
    BROWSER_TAB,
    ...(focus ? [] : ["--no-focus"]),
  ]);
  return rootPane(created);
}

async function viewerTab(workspace: string): Promise<string | undefined> {
  const tabs = records((await herdr("local", ["tab", "list", "--workspace", workspace]))["tabs"]);
  return field(
    tabs.find((each) => each["label"] === BROWSER_TAB),
    "tab_id",
  );
}

export async function removeViewer(workspace: string): Promise<boolean> {
  const tab = await viewerTab(workspace);
  const pane = tab === undefined ? undefined : await paneOf(workspace, tab);
  if (tab === undefined || pane === undefined || (await printedViewer(pane))?.mode !== "gated")
    return false;
  await herdr("local", ["tab", "close", tab]);
  return true;
}

export async function placeViewer(placement: Placement): Promise<Placed> {
  const { workspace, focus } = placement;
  const existing = await viewerTab(workspace);
  if (existing === undefined) {
    const pane = await create(placement);
    const launched = await launch(placement, pane);
    return { started: true, link: await linkOf(placement, pane, launched) };
  }
  const pane = await paneOf(workspace, existing);
  const launched =
    pane !== undefined && (await startable(placement, pane))
      ? await launch(placement, pane)
      : undefined;
  if (focus) await herdr("local", ["tab", "focus", existing]);
  return { started: launched !== undefined, link: await linkOf(placement, pane, launched) };
}

const isSummon = (entry: Entry, main: boolean): boolean =>
  entry.author === "browser" &&
  typeof entry.fields["summon"] === "string" &&
  (main || entry.fields["place"] === "lane");

let placing: Promise<unknown> = Promise.resolve();

function inOrder(placement: Placement): Promise<Placed> {
  const next = placing.catch(() => undefined).then(() => placeViewer(placement));
  placing = next;
  return next;
}

async function captainIsIn(workspace: string): Promise<boolean> {
  const listed = records((await herdr("local", ["workspace", "list"]))["workspaces"]);
  return listed.some((each) => each["workspace_id"] === workspace && each["focused"] === true);
}

export interface Summoned {
  readonly main: boolean;
  readonly source: Source;
  readonly home: string;
}

const KEEP_PRIVATE =
  "It is a password for that tab: send it only to the captain, in a message of its own, and never write it on the board, in a card, in a report, or in a log.";

const onThisMachineOnly = (link: string): boolean => {
  const { hostname } = new URL(link);
  return hostname === "127.0.0.1" || hostname === "localhost";
};

function linkNote(link: string | undefined): string {
  if (link === undefined)
    return " The captain's viewer is running in your Browser tab, but its address could not be read from there yet: read it from that tab. It is a password for the tab, so keep it to the captain.";
  if (onThisMachineOnly(link))
    return ` The captain's viewer listens on this machine only, because no Tailscale address was found, so his phone or another machine cannot open it. The address here is ${link} . Tell him so, and ask main's host to bring Tailscale up. ${KEEP_PRIVATE}`;
  return ` The captain's link, which opens on his phone or his Mac over Tailscale: ${link} . ${KEEP_PRIVATE}`;
}

async function answer(link: Link, entry: Entry, who: Summoned): Promise<string> {
  const workspace = process.env["HERDR_WORKSPACE_ID"];
  const here = workspace !== undefined && (who.main || (await captainIsIn(workspace)));
  if (here) {
    const placed = await inOrder({
      workspace,
      cwd: who.home,
      source: who.source,
      open: true,
      focus: true,
      captain: who.main,
      held: async () => (await link.call("browser.held", {})).held,
    });
    return who.main ? linkNote(placed.link) : "";
  }
  if (who.main) return "";
  await link.call("browser.summon", { card: entry.card, why: String(entry.fields["summon"]) });
  return "";
}

const NOT_YET =
  " The captain's viewer is still starting in your Browser tab: read its address from that tab when it appears.";

export function answerSummon(link: Link, entry: Entry, who: Summoned): Promise<string> | undefined {
  if (!isSummon(entry, who.main)) return undefined;
  const placed = answer(link, entry, who).catch((error: unknown) => {
    console.error(`browser view: ${String(error)}`);
    return who.main
      ? ` The captain's viewer could not be started (${error instanceof Error ? error.message : "unknown error"}): open the Browser tab of your workspace and start it from there.`
      : "";
  });
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<string>((resolve) => {
    timer = setTimeout(() => {
      resolve(who.main ? NOT_YET : "");
    }, SUMMON_WAIT_MS);
  });
  return Promise.race([placed, late]).finally(() => {
    clearTimeout(timer);
  });
}
