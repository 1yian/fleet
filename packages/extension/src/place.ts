import { createConnection } from "node:net";
import { field, herdr, isLocal, onHost, records, rootPane } from "./host.ts";

const MOVE_WAIT_MS = 5000;

async function socketPath(): Promise<string> {
  const session = process.env["HERDR_SESSION"];
  const own = process.env["HERDR_SOCKET_PATH"];
  if (session === undefined && own !== undefined) return own;
  const rows = (await onHost("local", ["herdr", "session", "list"])).split("\n");
  const row = rows
    .map((line) => line.trim().split(/\s+/))
    .find((cells) => cells[0] === (session ?? "default"));
  const socket = row?.at(-1);
  if (socket === undefined) throw new Error(`no herdr session ${session ?? "default"}`);
  return socket;
}

async function move(workspace: string, index: number): Promise<void> {
  const socket = await socketPath();
  const request = {
    id: "fleet-move",
    method: "workspace.move",
    params: { workspace_id: workspace, insert_index: index },
  };
  await new Promise<void>((resolve, reject) => {
    const client = createConnection(socket);
    const timer = setTimeout(() => {
      client.destroy();
      reject(new Error("herdr did not answer the move"));
    }, MOVE_WAIT_MS);
    client.once("error", reject);
    client.once("data", () => {
      clearTimeout(timer);
      client.end();
      resolve();
    });
    client.write(`${JSON.stringify(request)}\n`);
  });
}

export async function openWorkerWorkspace(
  host: string,
  cwd: string,
  card: { name: string; lane: string },
): Promise<string> {
  const listed = records((await herdr(host, ["workspace", "list"]))["workspaces"]);
  const parent = isLocal(host)
    ? listed.findIndex((each) => field(each, "label") === `fleet-${card.lane}`)
    : -1;
  const label = parent === -1 ? card.name : `└ ${card.name}`;
  const created = await herdr(host, [
    "workspace",
    "create",
    "--cwd",
    cwd,
    "--label",
    label,
    "--no-focus",
  ]);
  const workspace = field(records([created["workspace"]])[0], "workspace_id");
  if (parent !== -1 && workspace !== undefined) {
    let index = parent + 1;
    while (field(listed[index], "label")?.startsWith("└ ") === true) index += 1;
    await move(workspace, index).catch(() => undefined);
  }
  return rootPane(created);
}
