import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Entry } from "@fleet/protocol";
import { quote } from "@fleet/protocol/route";
import { viewerArguments, type Source } from "./browser-access.ts";
import { field, herdr, paneText, records, rootPane, shellIdle } from "./host.ts";
import type { Link } from "./link.ts";

const VIEWER = fileURLToPath(new URL("./browser-view.ts", import.meta.url));
const BROWSER_TAB = "Browser";
const MODE_LINE = /Fleet browser viewer \((captain|gated)\)/g;
const MODE_WAIT_MS = 5_000;
const STOP_WAIT_MS = 15_000;
const POLL_MS = 100;

export interface Placement {
  readonly workspace: string;
  readonly cwd: string;
  readonly source: Source;
  readonly open: boolean;
  readonly focus: boolean;
  readonly captain: boolean;
}

export type Placed = "opened" | "running";

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

async function printedMode(pane: string): Promise<string | undefined> {
  return [...(await paneText("local", pane)).matchAll(MODE_LINE)].at(-1)?.[1];
}

async function runningMode(pane: string): Promise<string | undefined> {
  let mode: string | undefined;
  await until(async () => {
    mode = await printedMode(pane);
    return mode !== undefined || (await shellIdle("local", pane));
  }, MODE_WAIT_MS);
  return mode;
}

async function stop(pane: string): Promise<void> {
  await herdr("local", ["pane", "send-keys", pane, "ctrl+c"]);
  if (!(await until(() => shellIdle("local", pane), STOP_WAIT_MS)))
    throw new Error(
      "the viewer in the Browser tab did not stop, so the captain's viewer was not started",
    );
}

async function startable(placement: Placement, pane: string): Promise<boolean> {
  if (await shellIdle("local", pane)) return true;
  if (!placement.captain || (await runningMode(pane)) !== "gated") return false;
  await stop(pane);
  return true;
}

const commandFor = ({ source, open, captain }: Placement): string =>
  `node ${quote(VIEWER)} ${viewerArguments(source).map(quote).join(" ")}${open ? " --open" : ""}${captain ? " --captain" : ""}`;

async function create(placement: Placement): Promise<void> {
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
  await herdr("local", ["pane", "run", rootPane(created), commandFor(placement)]);
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
  if (tab === undefined || pane === undefined || (await printedMode(pane)) !== "gated")
    return false;
  await herdr("local", ["tab", "close", tab]);
  return true;
}

export async function placeViewer(placement: Placement): Promise<Placed> {
  const { workspace, focus } = placement;
  const existing = await viewerTab(workspace);
  if (existing === undefined) {
    await create(placement);
    return "opened";
  }
  const pane = await paneOf(workspace, existing);
  let started = false;
  if (pane !== undefined && (await startable(placement, pane))) {
    await herdr("local", ["pane", "run", pane, commandFor(placement)]);
    started = true;
  }
  if (focus) await herdr("local", ["tab", "focus", existing]);
  return started ? "opened" : "running";
}

const isSummon = (entry: Entry, main: boolean): boolean =>
  entry.author === "browser" &&
  typeof entry.fields["summon"] === "string" &&
  (main || entry.fields["place"] === "lane");

let placing: Promise<unknown> = Promise.resolve();

function inOrder(placement: Placement): Promise<void> {
  const next = placing
    .catch(() => undefined)
    .then(() => placeViewer(placement))
    .then(() => undefined);
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

async function answer(link: Link, entry: Entry, who: Summoned): Promise<void> {
  const workspace = process.env["HERDR_WORKSPACE_ID"];
  const here = workspace !== undefined && (who.main || (await captainIsIn(workspace)));
  if (here) {
    await inOrder({
      workspace,
      cwd: who.home,
      source: who.source,
      open: true,
      focus: true,
      captain: who.main,
    });
    return;
  }
  if (who.main) return;
  await link.call("browser.summon", { card: entry.card, why: String(entry.fields["summon"]) });
}

export function answerSummon(link: Link, entry: Entry, who: Summoned): void {
  if (!isSummon(entry, who.main)) return;
  answer(link, entry, who).catch((error: unknown) => {
    console.error(`browser view: ${String(error)}`);
  });
}
