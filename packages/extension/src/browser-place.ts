import { fileURLToPath } from "node:url";
import type { Entry } from "@fleet/protocol";
import { viewerArguments, type Source } from "./browser-access.ts";
import { field, herdr, quote, records, rootPane, shellIdle } from "./host.ts";

const VIEWER = fileURLToPath(new URL("./browser-view.ts", import.meta.url));
const BROWSER_TAB = "Browser";

export interface Placement {
  readonly workspace: string;
  readonly cwd: string;
  readonly source: Source;
  readonly open: boolean;
  readonly focus: boolean;
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

const commandFor = ({ source, open }: Placement): string =>
  `node ${quote(VIEWER)} ${viewerArguments(source).map(quote).join(" ")}${open ? " --open" : ""}`;

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
  const idle = pane !== undefined && (await shellIdle("local", pane));
  if (idle) await herdr("local", ["pane", "run", pane, commandFor(placement)]);
  if (focus) await herdr("local", ["tab", "focus", existing]);
  return idle ? "opened" : "running";
}

export const isSummon = (entry: Entry): boolean =>
  entry.author === "browser" && typeof entry.fields["summon"] === "string";

export async function openForCaptain(source: Source, home: string): Promise<void> {
  const workspace = process.env["HERDR_WORKSPACE_ID"];
  if (workspace === undefined) return;
  await placeViewer({ workspace, cwd: home, source, open: true, focus: true });
}
