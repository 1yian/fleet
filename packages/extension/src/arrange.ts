import { createConnection } from "node:net";
import { field, herdr, isLocal, onFleetRoot, onHost, ownsHostName, records } from "./host.ts";
import { isRecord } from "./lane-config.ts";

const SOCKET_WAIT_MS = 5000;
const WORKER_MARK = "└ ";
const SOURCE = "fleet";
const HOST_NAME = /^[A-Za-z0-9._-]{1,40}$/;

interface Space {
  readonly id: string;
  readonly label: string;
  readonly lane: string | undefined;
  readonly card: number | undefined;
  readonly mate: string | undefined;
  readonly away: string | undefined;
}

interface Arrangement {
  readonly order: readonly string[];
  readonly labels: ReadonlyMap<string, string>;
  readonly hints: ReadonlyMap<string, string | undefined>;
}

const MATE_LABELS: readonly [RegExp, (match: RegExpExecArray) => string][] = [
  [/^1stmate$/, () => "main"],
  [/^2ndmate-(.+)$/, (match) => match[1] ?? ""],
];

const awayHint = (mate: string): string => `↗ mate on ${mate}`;

function mateLane(label: string): string | undefined {
  for (const [pattern, lane] of MATE_LABELS) {
    const match = pattern.exec(label);
    if (match !== null) return lane(match);
  }
  return undefined;
}

function bare(space: Space): string {
  const label = space.label.startsWith(WORKER_MARK)
    ? space.label.slice(WORKER_MARK.length)
    : space.label;
  const prefix = lanePrefix(space);
  return prefix !== "" && label.startsWith(prefix) ? label.slice(prefix.length) : label;
}

const lanePrefix = (space: Space): string => (space.lane === undefined ? "" : `[${space.lane}] `);

const byCard = (a: Space, b: Space): number =>
  (a.card ?? Number.MAX_SAFE_INTEGER) - (b.card ?? Number.MAX_SAFE_INTEGER);

const byLaneThenCard = (a: Space, b: Space): number => {
  const lanes = a.lane === b.lane ? 0 : (a.lane ?? "") < (b.lane ?? "") ? -1 : 1;
  return lanes === 0 ? byCard(a, b) : lanes;
};

const mainFirst = (a: string, b: string): number => {
  if (a === b) return 0;
  if (a === "main") return -1;
  if (b === "main") return 1;
  return a < b ? -1 : 1;
};

function matesOf(spaces: readonly Space[]): Map<string, Space> {
  const mates = new Map<string, Space>();
  for (const space of spaces) {
    const lane = mateLane(space.label);
    if (lane !== undefined && !mates.has(lane)) mates.set(lane, space);
  }
  return mates;
}

function hostedWorkers(spaces: readonly Space[], mates: ReadonlyMap<string, Space>) {
  const hosted = new Map<Space, string>();
  let previous: string | undefined;
  for (const space of spaces) {
    const lane = mateLane(space.label);
    previous = lane ?? space.lane ?? (space.label.startsWith(WORKER_MARK) ? previous : undefined);
    if (lane === undefined && previous !== undefined && mates.has(previous))
      hosted.set(space, previous);
  }
  return hosted;
}

function arrangement(spaces: readonly Space[]): Arrangement {
  const mates = matesOf(spaces);
  const hosted = hostedWorkers(spaces, mates);
  const heads = new Set(mates.values());
  const labels = new Map<string, string>();
  const hints = new Map<string, string | undefined>();
  for (const space of spaces) {
    if (heads.has(space)) continue;
    const prefix = hosted.has(space) ? WORKER_MARK : lanePrefix(space);
    const label = `${prefix}${bare(space)}`;
    if (label !== space.label) labels.set(space.id, label);
    const away =
      hosted.has(space) || space.mate === undefined || ownsHostName(space.mate)
        ? undefined
        : awayHint(space.mate);
    if (away !== space.away) hints.set(space.id, away);
  }
  const rest = spaces.filter((space) => !heads.has(space) && !hosted.has(space));
  const unowned = rest.filter((space) => space.lane === undefined);
  const strays = rest.filter((space) => space.lane !== undefined).sort(byLaneThenCard);
  const grouped = [...mates.keys()].sort(mainFirst).flatMap((lane) => {
    const own = spaces.filter((space) => hosted.get(space) === lane).sort(byCard);
    return [mates.get(lane), ...own];
  });
  const all = [...unowned, ...grouped, ...strays];
  const order = all.flatMap((space) => (space === undefined ? [] : [space.id]));
  return { order, labels, hints };
}

const token = (tokens: Record<string, unknown>, name: string): string | undefined => {
  const value = tokens[name];
  return typeof value === "string" && value !== "" ? value : undefined;
};

function spaceOf(row: Record<string, unknown>): Space | undefined {
  const id = field(row, "workspace_id");
  if (id === undefined) return undefined;
  const tokens = isRecord(row["tokens"]) ? row["tokens"] : {};
  const card = Number(tokens["card"]);
  const mate = token(tokens, "mate");
  return {
    id,
    label: field(row, "label") ?? "",
    lane: token(tokens, "lane"),
    card: Number.isInteger(card) ? card : undefined,
    mate: mate !== undefined && HOST_NAME.test(mate) ? mate : undefined,
    away: token(tokens, "away"),
  };
}

async function listed(host: string): Promise<Space[]> {
  const rows = records((await herdr(host, ["workspace", "list"]))["workspaces"]);
  return rows.flatMap((row) => spaceOf(row) ?? []);
}

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

async function moveBlock(ids: readonly string[]): Promise<void> {
  const socket = await socketPath();
  const request = {
    id: "fleet-arrange",
    method: "workspace.move_block",
    params: { workspace_ids: ids, before_workspace_id: null },
  };
  await new Promise<void>((resolve, reject) => {
    const client = createConnection(socket);
    let reply = "";
    const timer = setTimeout(() => {
      client.destroy();
      reject(new Error("herdr did not answer the move"));
    }, SOCKET_WAIT_MS);
    client.once("error", reject);
    client.on("data", (chunk) => {
      reply += String(chunk);
      if (!reply.includes("\n")) return;
      clearTimeout(timer);
      client.end();
      const parsed: unknown = JSON.parse(reply);
      const error = isRecord(parsed) && isRecord(parsed["error"]) ? parsed["error"] : undefined;
      if (error === undefined) resolve();
      else reject(new Error(String(error["message"])));
    });
    client.write(`${JSON.stringify(request)}\n`);
  });
}

export async function arrangeHere(): Promise<void> {
  const spaces = await listed("local");
  const { order, labels, hints } = arrangement(spaces);
  for (const [id, label] of labels) await herdr("local", ["workspace", "rename", id, label]);
  for (const [id, hint] of hints)
    await herdr("local", [
      "workspace",
      "report-metadata",
      id,
      "--source",
      SOURCE,
      ...(hint === undefined ? ["--clear-token", "away"] : ["--token", `away=${hint}`]),
    ]);
  const current = spaces.map((space) => space.id);
  const first = order.findIndex((id, index) => id !== current[index]);
  if (first !== -1) await moveBlock(order.slice(first));
}

export async function arrangeOn(host: string, root: string | undefined): Promise<void> {
  if (isLocal(host)) await arrangeHere();
  else await onFleetRoot(host, root, ["arrange"]);
}

export async function tagWorker(
  host: string,
  workspace: string,
  owner: { lane: string; card?: number; mate?: string | undefined },
): Promise<void> {
  const card = owner.card === undefined ? [] : ["--token", `card=${String(owner.card)}`];
  const mate = owner.mate === undefined ? [] : ["--token", `mate=${owner.mate}`];
  await herdr(host, [
    "workspace",
    "report-metadata",
    workspace,
    "--source",
    SOURCE,
    "--token",
    `lane=${owner.lane}`,
    ...card,
    ...mate,
  ]);
}

export async function claimFollowers(lane: string): Promise<void> {
  const spaces = await listed("local");
  const start = spaces.findIndex((space) => mateLane(space.label) === lane);
  if (start === -1) return;
  for (const space of spaces.slice(start + 1)) {
    if (!space.label.startsWith(WORKER_MARK)) break;
    if (space.lane === undefined) await tagWorker("local", space.id, { lane });
  }
}

const WORKTREE_CARD = /\.worktrees\/c-(\d+)-a\d+$/;

async function correctMates(
  host: string,
  spaces: readonly Space[],
  mateHosts: ReadonlyMap<string, string>,
): Promise<void> {
  for (const space of spaces) {
    const mate = mateHosts.get(space.lane ?? "");
    if (space.lane !== undefined && mate !== undefined && mate !== space.mate)
      await tagWorker(host, space.id, { lane: space.lane, mate });
  }
}

export async function tagWorkers(
  host: string,
  laneOfCard: ReadonlyMap<number, string>,
  mateHosts: ReadonlyMap<string, string>,
): Promise<void> {
  const spaces = await listed(host);
  await correctMates(host, spaces, mateHosts);
  const tagged = new Set(spaces.flatMap((s) => (s.lane === undefined ? [] : [s.id])));
  for (const pane of records((await herdr(host, ["pane", "list"]))["panes"])) {
    const workspace = field(pane, "workspace_id");
    const card = Number(WORKTREE_CARD.exec(field(pane, "cwd") ?? "")?.[1]);
    const lane = laneOfCard.get(card);
    if (workspace === undefined || lane === undefined || tagged.has(workspace)) continue;
    tagged.add(workspace);
    await tagWorker(host, workspace, { lane, card, mate: mateHosts.get(lane) });
  }
}
