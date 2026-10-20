// A worker's place in herdr's sidebar. It only changes what the captain sees.
// As in Firstmate, a worker's workspace sits right under its mate's workspace,
// fleet-<lane>, labeled with the card's name after "└ ". herdr does not nest
// plain workspaces, so the order and the label make the tree. A worker on a host
// without its mate's workspace stays at the top level, labeled with the name.
import { createConnection } from "node:net";
import { field, herdr, isLocal, onHost, records, rootPane } from "./host.ts";

const MOVE_WAIT_MS = 5000;

/** The socket of the herdr server that this process's herdr commands reach. */
async function socketPath(): Promise<string> {
  const session = process.env["HERDR_SESSION"];
  const own = process.env["HERDR_SOCKET_PATH"];
  if (session === undefined && own !== undefined) return own;
  // `herdr session list` prints a table: name, status, directory, socket.
  const rows = (await onHost("local", ["herdr", "session", "list"])).split("\n");
  const row = rows
    .map((line) => line.trim().split(/\s+/))
    .find((cells) => cells[0] === (session ?? "default"));
  const socket = row?.at(-1);
  if (socket === undefined) throw new Error(`no herdr session ${session ?? "default"}`);
  return socket;
}

/** Moves a workspace to a position in the sidebar, through herdr's socket API (the CLI has no move). */
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

/** Opens a workspace for a worker in `cwd`, under its mate's workspace when the mate's is on that host. Returns its pane. */
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
    // After the mate's workspace and the workers already under it.
    let index = parent + 1;
    while (field(listed[index], "label")?.startsWith("└ ") === true) index += 1;
    // The worker runs either way, so a failed move only leaves it at the end of the sidebar.
    await move(workspace, index).catch(() => undefined);
  }
  return rootPane(created);
}
