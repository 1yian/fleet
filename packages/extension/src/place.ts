import { arrangeOn, tagWorker } from "./arrange.ts";
import { field, herdr, ownHostName, records, rootOf, rootPane } from "./host.ts";

export async function openWorkerWorkspace(
  host: string,
  cwd: string,
  card: { name: string },
  environment: readonly string[],
): Promise<{ pane: string; workspace: string | undefined }> {
  const created = await herdr(host, [
    "workspace",
    "create",
    "--cwd",
    cwd,
    "--label",
    card.name,
    "--no-focus",
    ...environment.flatMap((pair) => ["--env", pair]),
  ]);
  return {
    pane: rootPane(created),
    workspace: field(records([created["workspace"]])[0], "workspace_id"),
  };
}

export async function claimWorkspace(
  host: string,
  workspace: string,
  card: { id: number; lane: string },
): Promise<void> {
  await tagWorker(host, workspace, {
    lane: card.lane,
    card: card.id,
    mate: ownHostName(),
  }).catch(() => undefined);
  await arrangeOn(host, rootOf(host)).catch(() => undefined);
}
