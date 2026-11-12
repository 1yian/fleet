import { field, herdr, records, rootPane } from "../host.ts";
import { launchWords } from "./invoke.ts";
import { FILES_TAB } from "./mates.ts";

const holdsTerminal = (): boolean => process.stdin.isTTY && process.stdout.isTTY;

export async function ensureFilesTab(home: string): Promise<void> {
  const workspace = process.env["HERDR_WORKSPACE_ID"];
  if (workspace === undefined || !holdsTerminal()) return;
  const tabs = records((await herdr("local", ["tab", "list", "--workspace", workspace]))["tabs"]);
  if (tabs.some((tab) => field(tab, "label") === FILES_TAB)) return;
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
  await herdr("local", ["pane", "run", rootPane(created), launchWords("files")]);
}
