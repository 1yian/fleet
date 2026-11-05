import { fileURLToPath } from "node:url";
import type { Entry } from "@fleet/protocol";
import { viewerArguments, type Source } from "./browser-access.ts";
import { field, herdr, paneText, quote, records, rootPane, shellIdle } from "./host.ts";

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

export async function placeViewer(placement: Placement): Promise<Placed> {
  const { workspace, focus } = placement;
  const tabs = records((await herdr("local", ["tab", "list", "--workspace", workspace]))["tabs"]);
  const existing = field(
    tabs.find((each) => each["label"] === BROWSER_TAB),
    "tab_id",
  );
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

export const isSummon = (entry: Entry): boolean =>
  entry.author === "browser" && typeof entry.fields["summon"] === "string";

let placing: Promise<unknown> = Promise.resolve();

export function openForCaptain(source: Source, home: string): Promise<void> {
  const workspace = process.env["HERDR_WORKSPACE_ID"];
  if (workspace === undefined) return Promise.resolve();
  const next = placing
    .catch(() => undefined)
    .then(() =>
      placeViewer({ workspace, cwd: home, source, open: true, focus: true, captain: true }),
    )
    .then(() => undefined);
  placing = next;
  return next;
}
