import { arrangeOn, tagWorker } from "./arrange.ts";
import { field, herdr, records, rootPane } from "./host.ts";
import { isRecord } from "./lane-config.ts";

export async function openWorkerWorkspace(
  host: string,
  cwd: string,
  card: { id: number; name: string; lane: string },
): Promise<string> {
  const created = await herdr(host, [
    "workspace",
    "create",
    "--cwd",
    cwd,
    "--label",
    card.name,
    "--no-focus",
  ]);
  const workspace = field(records([created["workspace"]])[0], "workspace_id");
  if (workspace !== undefined) {
    await tagWorker(host, workspace, { lane: card.lane, card: card.id }).catch(() => undefined);
    await arrangeOn(host, rootOf(host)).catch(() => undefined);
  }
  return rootPane(created);
}

function rootOf(host: string): string | undefined {
  const roots: unknown = JSON.parse(process.env["FLEET_ROOTS"] ?? "{}");
  const root = isRecord(roots) ? roots[host] : undefined;
  return typeof root === "string" ? root : undefined;
}
