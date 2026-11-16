import { quote } from "@fleet/protocol/route";
import { field, herdr, records, rootPane } from "../host.ts";
import { launchWords } from "./invoke.ts";
import { FILES_TAB } from "./mates.ts";

const holdsTerminal = (): boolean => process.stdin.isTTY && process.stdout.isTTY;

const SHELLS = new Set(["sh", "bash", "zsh", "fish", "dash", "ksh", "tcsh", "csh", "nu", "xonsh"]);

async function idleShell(pane: string): Promise<boolean> {
  const reply = await herdr("local", ["pane", "process-info", "--pane", pane]);
  const info = records([reply["process_info"]])[0];
  const running = records(info?.["foreground_processes"]);
  const [only] = running;
  return (
    running.length === 1 &&
    only?.["pid"] === info?.["shell_pid"] &&
    SHELLS.has(field(only, "name") ?? "")
  );
}

const startExplorer = (pane: string, home: string): Promise<unknown> =>
  herdr("local", ["pane", "run", pane, `cd ${quote(home)} && ${launchWords("files")}`]);

async function restartIfIdle(workspace: string, tab: string, home: string): Promise<void> {
  const listed = records(
    (await herdr("local", ["pane", "list", "--workspace", workspace]))["panes"],
  );
  const panes = listed.filter((pane) => field(pane, "tab_id") === tab);
  const ids = panes.flatMap((pane) => field(pane, "pane_id") ?? []);
  const [first] = ids;
  if (first === undefined) return;
  if (!(await Promise.all(ids.map(idleShell))).every(Boolean)) return;
  await startExplorer(first, home);
}

export async function ensureFilesTab(home: string): Promise<void> {
  const workspace = process.env["HERDR_WORKSPACE_ID"];
  if (workspace === undefined || !holdsTerminal()) return;
  const tabs = records((await herdr("local", ["tab", "list", "--workspace", workspace]))["tabs"]);
  const existing = field(
    tabs.find((tab) => field(tab, "label") === FILES_TAB),
    "tab_id",
  );
  if (existing !== undefined) return restartIfIdle(workspace, existing, home);
  const created = await herdr("local", [
    "tab",
    "create",
    "--workspace",
    workspace,
    "--cwd",
    home,
    "--label",
    FILES_TAB,
    "--no-focus",
  ]);
  await startExplorer(rootPane(created), home);
}
