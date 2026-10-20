// herdr on a host (spec section 15). A host listed in FLEET_HOSTS runs herdr
// through its transport, such as ["ssh", "p620"]. Any other host runs herdr here.
// HERDR_SESSION, when set, selects a named herdr session (used by lab tests).
import { execFile } from "node:child_process";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function transport(host: string): string[] {
  const hosts: unknown = JSON.parse(process.env["FLEET_HOSTS"] ?? "{}");
  const entry = isRecord(hosts) ? hosts[host] : undefined;
  return Array.isArray(entry) ? entry.filter((part) => typeof part === "string") : [];
}

export const quote = (arg: string): string => `'${arg.replaceAll("'", `'\\''`)}'`;

/** A herdr failure message for the mate: never the command line, and never a worker token. */
const scrub = (message: string): string =>
  message.replace(/--fleet-token\W+[^\s'"]+/g, "--fleet-token [hidden]");

/**
 * The transport could not reach the host: ssh exits with status 255 for a lost or refused
 * connection, or the reachability probe (herdr called with `probe`) ran past its timeout.
 * A timeout on any other step is a plain failure.
 */
export class HostUnreachable extends Error {}

const PROBE_TIMEOUT_MS = 60_000;

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

/** Runs one herdr command on the host and returns its `result` object. Throws herdr's error message. */
export async function herdr(
  host: string,
  args: readonly string[],
  probe = false,
): Promise<Record<string, unknown>> {
  const session = process.env["HERDR_SESSION"];
  // --session must come before a "--" delimiter, or herdr passes it on to the agent.
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

/** The `result` object of herdr's JSON output. Some commands, such as pane run, print nothing when they succeed. */
function resultOf(stdout: string, host: string, name: string): Record<string, unknown> {
  if (stdout.trim() === "") return {};
  const reply: unknown = JSON.parse(stdout);
  if (!isRecord(reply)) throw new Error(`herdr ${name} on ${host} returned no JSON object`);
  if (isRecord(reply["error"])) throw new Error(scrub(String(reply["error"]["message"])));
  return isRecord(reply["result"]) ? reply["result"] : {};
}

/** Runs a command on the host and returns its output. Throws with the command's error output on a non-zero exit. */
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

/** The items of an array field, keeping only objects. */
export const records = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.filter(isRecord) : [];
export const field = (
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined => {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
};

/** The root pane that a herdr create command returned. */
export function rootPane(result: Record<string, unknown>): string {
  const pane = isRecord(result["root_pane"]) ? field(result["root_pane"], "pane_id") : undefined;
  if (pane === undefined) throw new Error("herdr did not return a pane");
  return pane;
}

/** Whether a host runs here, not through a transport such as SSH. */
export const isLocal = (host: string): boolean => transport(host).length === 0;

/**
 * The attempt's git worktree among `herdr worktree list` results: the one at
 * `<clone>.worktrees/<session>`. The worker may switch to its own branch, so the path is the key.
 */
export function worktreeOf(
  listed: Record<string, unknown>,
  session: string,
): Record<string, unknown> | undefined {
  return records(listed["worktrees"]).find(
    (tree) => field(tree, "path")?.endsWith(`.worktrees/${session}`) === true,
  );
}

/** What runs in the pane's foreground, and the pane's shell. */
async function foreground(
  host: string,
  pane: string,
): Promise<{ group: unknown; shell: unknown; processes: Record<string, unknown>[] }> {
  const info = (await herdr(host, ["pane", "process-info", "--pane", pane]))["process_info"];
  if (!isRecord(info)) return { group: undefined, shell: undefined, processes: [] };
  const processes = records(info["foreground_processes"]);
  return { group: info["foreground_process_group_id"], shell: info["shell_pid"], processes };
}

/**
 * Whether a Pi runs in the pane's foreground. Pi names its process "pi". Other foreground
 * processes do not count: an idle shell's prompt runs helpers such as git there too.
 */
export async function piRunning(host: string, pane: string): Promise<boolean> {
  const { processes } = await foreground(host, pane);
  // macOS reports the name as argv0, and Linux as the process name.
  return processes.some((each) => field(each, "argv0") === "pi" || field(each, "name") === "pi");
}

/** Whether the pane's shell waits at its prompt with nothing else in the foreground. */
export async function shellIdle(host: string, pane: string): Promise<boolean> {
  const { group, shell } = await foreground(host, pane);
  return group !== undefined && group === shell;
}
