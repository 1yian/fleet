import { hostname } from "node:os";
import { fleetHostName, routed } from "@fleet/protocol/route";
import { type Detach, runOnTransport } from "@fleet/protocol/transport";
import { spawnDetached } from "./detached.ts";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export class HostUnreachable extends Error {}

export class NoTransport extends HostUnreachable {}

export class HostUnread extends Error {}

class LanePaneNotFound extends Error {}

class LaneServerMissing extends Error {}

type LaneCommand = "observe" | "mutate";

export class TimedOut extends Error {}

export class WorkspaceNotFound extends Error {}

const firstLabel = (name: string): string => (name.toLowerCase().split(".")[0] ?? "").trim();

function ownNames(): string[] {
  const named = process.env["FLEET_HOST"];
  if (named !== undefined && named !== "") return [named.toLowerCase(), firstLabel(named)];
  return [hostname().toLowerCase(), firstLabel(hostname())];
}

export const ownHostName = (): string => ownNames().at(-1) ?? "local";

const ownsHostName = (host: string): boolean =>
  host === "local" || host === fleetHostName() || ownNames().includes(host.toLowerCase());

function transport(host: string): string[] {
  const hosts: unknown = JSON.parse(process.env["FLEET_HOSTS"] ?? "{}");
  const entry = isRecord(hosts) && Object.hasOwn(hosts, host) ? hosts[host] : undefined;
  if (Array.isArray(entry)) return entry.filter((part) => typeof part === "string");
  if (ownsHostName(host)) return [];
  throw new NoTransport(`no transport for ${host}`);
}

export function rootOf(host: string): string | undefined {
  const roots: unknown = JSON.parse(process.env["FLEET_ROOTS"] ?? "{}");
  const root = isRecord(roots) ? roots[host] : undefined;
  return typeof root === "string" ? root : undefined;
}

const JSON_STRING = String.raw`"(?:[^"\\]|\\.)*"`;
const JSON_FLAT_OBJECT = String.raw`\{(?:${JSON_STRING}|[^"{}])*\}`;
const BWS_ARGUMENT = new RegExp(
  String.raw`--fleet-bws=\{(?:${JSON_STRING}|[^"{}]|${JSON_FLAT_OBJECT})*\}`,
  "g",
);

export const scrub = (text: string, secrets: readonly string[] = []): string =>
  secrets
    .filter((secret) => secret !== "")
    .reduce(
      (out, secret) => out.replaceAll(secret, "[hidden]"),
      text
        .replace(/--fleet-token\W+[^\s'"]+/g, "--fleet-token [hidden]")
        .replace(BWS_ARGUMENT, "--fleet-bws=[hidden]"),
    );

const PROBE_TIMEOUT_MS = Number(process.env["FLEET_PROBE_TIMEOUT_MS"]) || 60_000;

export const SCAN_TIMEOUT_MS = Number(process.env["FLEET_SCAN_TIMEOUT_MS"]) || 180_000;

const failure = (
  via: readonly string[],
  error: { code?: unknown; killed?: unknown },
  message: string,
  probe: boolean,
): Error =>
  via.length > 0 && (error.code === 255 || (probe && error.killed === true))
    ? new HostUnreachable(message)
    : new Error(message);

const exitStatus = (error: { code?: unknown; signal?: unknown }): string =>
  typeof error.signal === "string"
    ? `killed by ${error.signal}`
    : `exit status ${String(error.code)}`;

const OPEN_FILES = 65_536;
const SERVER_WAIT_MS = 30_000;
const RAISE_OPEN_FILES = `hard=$(ulimit -Hn); soft=$(ulimit -Sn); want=${String(OPEN_FILES)}; if [ "$hard" != unlimited ] && [ "$hard" -lt "$want" ]; then want=$hard; fi; if [ "$soft" != unlimited ] && [ "$soft" -lt "$want" ]; then ulimit -Sn "$want" 2>/dev/null; fi; exec "$@"`;

const serverMissing = (error: unknown): boolean =>
  error instanceof Error && error.message.includes("server_not_running");

let starting: Promise<void> | undefined;

function startServer(session: string | undefined): Promise<void> {
  starting ??= (async () => {
    const select = session === undefined ? [] : ["--session", session];
    const server = spawnDetached(
      "sh",
      ["-c", RAISE_OPEN_FILES, "herdr", "herdr", "server", ...select],
      {
        stdio: "ignore",
      },
    );
    server.unref();
    const child = { exited: false };
    server.once("exit", () => {
      child.exited = true;
    });
    const deadline = Date.now() + SERVER_WAIT_MS;
    while (Date.now() < deadline) {
      const up = await herdrOnce("local", ["workspace", "list"], true).then(
        () => true,
        (error: unknown) => !serverMissing(error),
      );
      if (up) return;
      if (child.exited) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("herdr server did not start");
  })().finally(() => {
    starting = undefined;
  });
  return starting;
}

export async function herdr(
  host: string,
  args: readonly string[],
  probe = false,
): Promise<Record<string, unknown>> {
  try {
    return await herdrOnce(host, args, probe);
  } catch (error) {
    if (!serverMissing(error) || transport(host).length > 0) throw error;
    await startServer(process.env["HERDR_SESSION"]);
    return herdrOnce(host, args, probe);
  }
}

export async function laneHerdr(
  args: readonly string[],
  mode: LaneCommand,
): Promise<Record<string, unknown>> {
  try {
    return await laneHerdrOnce(args, mode);
  } catch (error) {
    if (!(error instanceof LaneServerMissing)) throw error;
    try {
      await startServer(process.env["HERDR_SESSION"]);
      return await laneHerdrOnce(args, mode);
    } catch (failure) {
      if (mode === "observe" && !(failure instanceof LanePaneNotFound) && failure instanceof Error)
        throw new HostUnread(failure.message);
      throw failure;
    }
  }
}

async function laneHerdrOnce(
  args: readonly string[],
  mode: LaneCommand,
): Promise<Record<string, unknown>> {
  const out = await herdrText("local", args, mode === "observe", mode);
  const [noun, verb] = args;
  const reply = jsonRecord(out);
  const refusal = laneRefusal(reply, args);
  if (refusal !== undefined) throw refusal;
  if (noun === "pane" && verb === "run") {
    if (out.trim() === "") return {};
  } else if (isRecord(reply?.["result"]) && reply["error"] === undefined) return reply["result"];
  const message = `herdr ${args.slice(0, 2).join(" ")} returned no complete result`;
  throw mode === "observe" ? new HostUnread(message) : new Error(message);
}

function jsonRecord(out: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(out);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function laneRefusal(
  reply: Record<string, unknown> | undefined,
  [, verb]: readonly string[],
): Error | undefined {
  const error = reply?.["error"];
  if (!isRecord(error) || reply?.["result"] !== undefined) return undefined;
  if (typeof error["message"] !== "string" || error["message"].trim() === "") return undefined;
  const message = scrub(error["message"]);
  switch (error["code"]) {
    case "pane_not_found":
      return verb === "process-info" ? new LanePaneNotFound(message) : undefined;
    case "server_not_running":
      return new LaneServerMissing(message);
    default:
      return undefined;
  }
}

async function herdrOnce(
  host: string,
  args: readonly string[],
  probe: boolean,
): Promise<Record<string, unknown>> {
  return resultOf(await herdrText(host, args, probe), host, args[0] ?? "");
}

export const paneText = (host: string, pane: string): Promise<string> =>
  herdrText(host, ["pane", "read", pane, "--source", "recent-unwrapped", "--lines", "200"], false);

function laneTransportFailure(
  lane: LaneCommand,
  args: readonly string[],
  error: { code?: unknown; signal?: unknown },
  out: string,
  err: string,
): Error {
  const refusal =
    error.code === 1 ? laneRefusal(jsonRecord(out.trim() === "" ? err : out), args) : undefined;
  if (refusal !== undefined) return refusal;
  const message = scrub(
    `herdr ${args.slice(0, 2).join(" ")} failed: ${err.trim() || exitStatus(error)}`,
  );
  return lane === "observe" ? new HostUnread(message) : new Error(message);
}

async function herdrText(
  host: string,
  args: readonly string[],
  probe: boolean,
  lane?: LaneCommand,
): Promise<string> {
  const session = process.env["HERDR_SESSION"];
  const split = args.includes("--") ? args.indexOf("--") : args.length;
  const select = session === undefined ? [] : ["--session", session];
  const command = ["herdr", ...args.slice(0, split), ...select, ...args.slice(split)];
  const via = transport(host);
  const [file = "herdr", ...rest] = routed(via, command);
  return new Promise<string>((resolve, reject) => {
    runOnTransport(
      file,
      rest,
      { timeout: probe ? PROBE_TIMEOUT_MS : 120_000 },
      (error, out, err) => {
        if (error !== null && lane !== undefined) {
          reject(laneTransportFailure(lane, args, error, out, err));
        } else if (error !== null && out.trim() === "") {
          const message = `herdr ${args[0] ?? ""} on ${host} failed: ${err.trim() || exitStatus(error)}`;
          reject(failure(via, error, scrub(message), probe));
        } else resolve(out);
      },
    );
  });
}

function resultOf(stdout: string, host: string, name: string): Record<string, unknown> {
  if (stdout.trim() === "") return {};
  const reply: unknown = JSON.parse(stdout);
  if (!isRecord(reply)) throw new Error(`herdr ${name} on ${host} returned no JSON object`);
  const error = reply["error"];
  if (isRecord(error)) {
    const message = scrub(String(error["message"]));
    if (error["code"] === "workspace_not_found" || message === "workspace_not_found")
      throw new WorkspaceNotFound(message);
    throw new Error(message);
  }
  return isRecord(reply["result"]) ? reply["result"] : {};
}

export const HELPER_MARK = "FLEET_HELPER";

const ownGroup: Detach = (file, args) =>
  spawnDetached(file, args, { stdio: ["ignore", "pipe", "pipe"] });

async function run(
  host: string,
  argv: readonly string[],
  timeout: number,
  spawned: readonly string[],
  detach?: Detach,
  grace?: number,
): Promise<string> {
  const via = transport(host);
  const [file = "", ...rest] = routed(via, spawned);
  return new Promise((resolve, reject) => {
    runOnTransport(
      file,
      rest,
      {
        timeout,
        maxBuffer: 16 * 1024 * 1024,
        ...(detach === undefined ? {} : { detach }),
        ...(grace === undefined ? {} : { grace }),
      },
      (error, out, err) => {
        if (error === null) resolve(out);
        else if (error.killed === true)
          reject(
            new TimedOut(
              `${argv[0] ?? ""} on ${host} did not finish within ${String(timeout)} ms and was stopped`,
            ),
          );
        else {
          const message = `${argv[0] ?? ""} on ${host} failed: ${err.trim() || exitStatus(error)}`;
          reject(failure(via, error, scrub(message), false));
        }
      },
    );
  });
}

export const onHost = (host: string, argv: readonly string[], timeout = 600_000): Promise<string> =>
  run(host, argv, timeout, argv);

export const onHelper = (
  host: string,
  argv: readonly string[],
  timeout = 600_000,
  grace?: number,
): Promise<string> =>
  run(host, argv, timeout, ["env", `${HELPER_MARK}=1`, ...argv], ownGroup, grace);

const FLEET_ON_ROOT = 'root=${1:-$HOME/.fleet/app}; shift; exec "$root/bin/fleet" "$@"';

export function onFleetRoot(
  host: string,
  root: string | undefined,
  args: readonly string[],
  timeout?: number,
): Promise<string> {
  return onHost(host, ["sh", "-c", FLEET_ON_ROOT, "fleet", root ?? "", ...args], timeout);
}

export const records = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.filter(isRecord) : [];
export const field = (
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined => {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
};

export function rootPane(result: Record<string, unknown>): string {
  const pane = isRecord(result["root_pane"]) ? field(result["root_pane"], "pane_id") : undefined;
  if (pane === undefined) throw new Error("herdr did not return a pane");
  return pane;
}

export const isLocal = (host: string): boolean => transport(host).length === 0;

export function worktreeOf(
  listed: Record<string, unknown>,
  session: string,
): Record<string, unknown> | undefined {
  return records(listed["worktrees"]).find(
    (tree) => field(tree, "path")?.endsWith(`.worktrees/${session}`) === true,
  );
}

async function foreground(
  host: string,
  pane: string,
): Promise<{
  missing: boolean;
  group: unknown;
  shell: unknown;
  processes: Record<string, unknown>[];
}> {
  const reply: Record<string, unknown> = await herdr(host, [
    "pane",
    "process-info",
    "--pane",
    pane,
  ]).catch((error: unknown) => {
    if (error instanceof Error && error.message.includes("pane_not_found"))
      return { missing: true };
    throw error;
  });
  const info = reply["process_info"];
  if (!isRecord(info))
    return {
      missing: reply["missing"] === true,
      group: undefined,
      shell: undefined,
      processes: [],
    };
  const processes = records(info["foreground_processes"]);
  return {
    missing: false,
    group: info["foreground_process_group_id"],
    shell: info["shell_pid"],
    processes,
  };
}

function isPi(process: Record<string, unknown>): boolean {
  const argv = Array.isArray(process["argv"]) ? process["argv"] : [];
  const script = typeof argv[1] === "string" ? argv[1] : "";
  return (
    field(process, "argv0") === "pi" ||
    field(process, "name") === "pi" ||
    (argv[0] === "node" && script.split("/").pop() === "pi")
  );
}

export async function piRunning(host: string, pane: string): Promise<boolean> {
  const { processes } = await foreground(host, pane);
  return processes.some(isPi);
}

export async function piPids(host: string, pane: string): Promise<number[]> {
  const { processes } = await foreground(host, pane);
  return processes
    .filter(isPi)
    .flatMap((each) => (typeof each["pid"] === "number" ? [each["pid"]] : []));
}

export async function shellPid(host: string, pane: string): Promise<number | undefined> {
  const { shell } = await foreground(host, pane);
  return typeof shell === "number" ? shell : undefined;
}

export async function shellIdle(host: string, pane: string): Promise<boolean> {
  const { group, shell } = await foreground(host, pane);
  return group !== undefined && group === shell;
}

function completeLaneProcess(row: Record<string, unknown>): boolean {
  const argv = row["argv"];
  return (
    Number.isInteger(row["pid"]) &&
    typeof row["name"] === "string" &&
    Array.isArray(argv) &&
    argv.every((arg) => typeof arg === "string")
  );
}

export async function lanePaneState(pane: string): Promise<"pi" | "busy" | "down"> {
  const reply = await laneHerdr(["pane", "process-info", "--pane", pane], "observe").catch(
    (error: unknown) => {
      if (error instanceof LanePaneNotFound) return undefined;
      throw error;
    },
  );
  if (reply === undefined) return "down";
  const info = reply["process_info"];
  if (!isRecord(info)) throw new HostUnread(`herdr returned no process info for pane ${pane}`);
  const entries = info["foreground_processes"];
  const processes = records(entries);
  if (
    !Array.isArray(entries) ||
    processes.length !== entries.length ||
    processes.some((row) => !completeLaneProcess(row))
  )
    throw new HostUnread(`herdr returned an incomplete process list for pane ${pane}`);
  if (processes.some(isPi)) return "pi";
  const shell = info["shell_pid"];
  const group = info["foreground_process_group_id"];
  if (!Number.isInteger(shell) || !Number.isInteger(group))
    throw new HostUnread(`herdr returned no shell or foreground group for pane ${pane}`);
  return shell === group ? "down" : "busy";
}
