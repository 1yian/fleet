import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { field, herdr, quote, records, rootPane, shellIdle } from "./host.ts";
import type { Link } from "./link.ts";

const VIEWER = fileURLToPath(new URL("./browser-view.ts", import.meta.url));
const BROWSER_TAB = "Browser";

async function paneOf(workspace: string, tab: string): Promise<string | undefined> {
  const panes = records(
    (await herdr("local", ["pane", "list", "--workspace", workspace]))["panes"],
  );
  return field(
    panes.find((each) => each["tab_id"] === tab),
    "pane_id",
  );
}

async function ensure(home: string): Promise<void> {
  const workspace = process.env["HERDR_WORKSPACE_ID"];
  if (workspace === undefined) return;
  const command = `node ${quote(VIEWER)} ${quote(home)} --open`;
  const tabs = records((await herdr("local", ["tab", "list", "--workspace", workspace]))["tabs"]);
  const existing = field(
    tabs.find((each) => each["label"] === BROWSER_TAB),
    "tab_id",
  );
  if (existing === undefined) {
    const created = await herdr("local", [
      "tab",
      "create",
      "--workspace",
      workspace,
      "--cwd",
      home,
      "--label",
      BROWSER_TAB,
      "--no-focus",
    ]);
    await herdr("local", ["pane", "run", rootPane(created), command]);
    return;
  }
  const pane = await paneOf(workspace, existing);
  if (pane !== undefined && (await shellIdle("local", pane)))
    await herdr("local", ["pane", "run", pane, command]);
}

export function showBrowserTab(pi: ExtensionAPI, link: Link, home: string): void {
  let started = false;
  pi.events.on("fleet:connected", () => {
    if (started) return;
    started = true;
    void link
      .call("browser.view", {})
      .then(({ endpoint }) => (endpoint === null ? undefined : ensure(home)))
      .catch((error: unknown) => {
        console.error(`browser tab: ${String(error)}`);
      });
  });
}
