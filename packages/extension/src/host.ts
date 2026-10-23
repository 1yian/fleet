import { execFile } from "node:child_process";
import { hostname } from "node:os";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export class HostUnreachable extends Error {}

export class NoTransport extends HostUnreachable {}

const firstLabel = (name: string): string => (name.toLowerCase().split(".")[0] ?? "").trim();

function ownNames(): string[] {
  const named = process.env["FLEET_HOST"];
  if (named !== undefined && named !== "") return [named.toLowerCase(), firstLabel(named)];
  return [hostname().toLowerCase(), firstLabel(hostname())];
}

const ownsHostName = (host: string): boolean =>
  host === "local" || ownNames().includes(host.toLowerCase());

function transport(host: string): string[] {
  const hosts: unknown = JSON.parse(process.env["FLEET_HOSTS"] ?? "{}");
  const entry = isRecord(hosts) ? hosts[host] : undefined;
  if (Array.isArray(entry)) return entry.filter((part) => typeof part === "string");
  if (ownsHostName(host)) return [];
  throw new NoTransport(`no transport for ${host}`);
}

export const quote = (arg: string): string => `'${arg.replaceAll("'", `'\\''`)}'`;

const scrub = (message: string): string =>
  message.replace(/--fleet-token\W+[^\s'"]+/g, "--fleet-token [hidden]");

const PROBE_TIMEOUT_MS = Number(process.env["FLEET_PROBE_TIMEOUT_MS"]) || 60_000;

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

export async function herdr(
  host: string,
  args: readonly string[],
  probe = false,
): Promise<Record<string, unknown>> {
  const session = process.env["HERDR_SESSION"];
  const split = args.includes("--") ? args.indexOf("--") : args.length;
  const select = session === undefined ? [] : ["--session", session];
  const command = ["herdr", ...args.slice(0, split), ...select, ...args.slice(split)];
  const via = transport(host);
  const [file = "herdr", ...rest] =
    via.length === 0 ? command : [...via, command.map(quote).join(" ")];
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(
      file,
      rest,
      { encoding: "utf8", timeout: probe ? PROBE_TIMEOUT_MS : 120_000 },
      (error, out, err) => {
        if (error !== null && out.trim() === "") {
          const message = `herdr ${args[0] ?? ""} on ${host} failed: ${err.trim() || exitStatus(error)}`;
          reject(failure(via, error, scrub(message), probe));
        } else resolve(out);
      },
    );
  });
  return resultOf(stdout, host, args[0] ?? "");
}

function resultOf(stdout: string, host: string, name: string): Record<string, unknown> {
  if (stdout.trim() === "") return {};
  const reply: unknown = JSON.parse(stdout);
  if (!isRecord(reply)) throw new Error(`herdr ${name} on ${host} returned no JSON object`);
  if (isRecord(reply["error"])) throw new Error(scrub(String(reply["error"]["message"])));
  return isRecord(reply["result"]) ? reply["result"] : {};
}

export async function onHost(
  host: string,
  argv: readonly string[],
  timeout = 600_000,
): Promise<string> {
  const via = transport(host);
  const [file = "", ...rest] = via.length === 0 ? argv : [...via, argv.map(quote).join(" ")];
  return new Promise((resolve, reject) => {
    execFile(
      file,
      rest,
      { encoding: "utf8", timeout, maxBuffer: 16 * 1024 * 1024 },
      (error, out, err) => {
        if (error === null) resolve(out);
        else {
          const message = `${argv[0] ?? ""} on ${host} failed: ${err.trim() || exitStatus(error)}`;
          reject(failure(via, error, scrub(message), false));
        }
      },
    );
  });
}

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
): Promise<{ group: unknown; shell: unknown; processes: Record<string, unknown>[] }> {
  const info = (await herdr(host, ["pane", "process-info", "--pane", pane]))["process_info"];
  if (!isRecord(info)) return { group: undefined, shell: undefined, processes: [] };
  const processes = records(info["foreground_processes"]);
  return { group: info["foreground_process_group_id"], shell: info["shell_pid"], processes };
}

export async function piRunning(host: string, pane: string): Promise<boolean> {
  const { processes } = await foreground(host, pane);
  return processes.some((each) => field(each, "argv0") === "pi" || field(each, "name") === "pi");
}

export async function piPids(host: string, pane: string): Promise<number[]> {
  const { processes } = await foreground(host, pane);
  return processes
    .filter((each) => field(each, "argv0") === "pi" || field(each, "name") === "pi")
    .flatMap((each) => (typeof each["pid"] === "number" ? [each["pid"]] : []));
}

export async function shellIdle(host: string, pane: string): Promise<boolean> {
  const { group, shell } = await foreground(host, pane);
  return group !== undefined && group === shell;
}
