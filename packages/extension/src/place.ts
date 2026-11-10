import { arrangeOn, tagWorker } from "./arrange.ts";
import { field, herdr, records, rootOf, rootPane } from "./host.ts";

export async function openWorkerWorkspace(
  host: string,
  cwd: string,
  card: { id: number; name: string; lane: string },
  environment: readonly string[],
): Promise<string> {
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
  const workspace = field(records([created["workspace"]])[0], "workspace_id");
  if (workspace !== undefined) {
    await tagWorker(host, workspace, { lane: card.lane, card: card.id }).catch(() => undefined);
    await arrangeOn(host, rootOf(host)).catch(() => undefined);
  }
  return rootPane(created);
}
