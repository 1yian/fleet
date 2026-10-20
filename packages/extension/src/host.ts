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

/** The transport could not reach the host: ssh exits with status 255 for a lost or refused connection. */
export class HostUnreachable extends Error {}

const unreachable = (via: readonly string[], error: { code?: unknown }): boolean =>
  via.length > 0 && error.code === 255;

const exitStatus = (error: { code?: unknown; signal?: unknown }): string =>
  typeof error.signal === "string"
    ? `killed by ${error.signal}`
    : `exit status ${String(error.code)}`;

/** Runs one herdr command on the host and returns its `result` object. Throws herdr's error message. */
export async function herdr(
  host: string,
  args: readonly string[],
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
    execFile(file, rest, { encoding: "utf8", timeout: 120_000 }, (error, out, err) => {
      if (error !== null && out.trim() === "") {
        const failure = scrub(
          `herdr ${args[0] ?? ""} on ${host} failed: ${err.trim() || exitStatus(error)}`,
        );
        reject(unreachable(via, error) ? new HostUnreachable(failure) : new Error(failure));
      } else resolve(out);
    });
  });
  // Some commands, such as pane run, print nothing when they succeed.
  if (stdout.trim() === "") return {};
  const reply: unknown = JSON.parse(stdout);
  if (!isRecord(reply))
    throw new Error(`herdr ${args[0] ?? ""} on ${host} returned no JSON object`);
  if (isRecord(reply["error"])) throw new Error(scrub(String(reply["error"]["message"])));
  return isRecord(reply["result"]) ? reply["result"] : {};
}

/** Runs a command on the host and returns its output. Throws with the command's error output on a non-zero exit. */
export async function onHost(host: string, argv: readonly string[]): Promise<string> {
  const via = transport(host);
  const [file = "", ...rest] = via.length === 0 ? argv : [...via, argv.map(quote).join(" ")];
  return new Promise((resolve, reject) => {
    execFile(
      file,
      rest,
      { encoding: "utf8", timeout: 600_000, maxBuffer: 16 * 1024 * 1024 },
      (error, out, err) => {
        if (error === null) resolve(out);
        else {
          const failure = scrub(
            `${argv[0] ?? ""} on ${host} failed: ${err.trim() || exitStatus(error)}`,
          );
          reject(unreachable(via, error) ? new HostUnreachable(failure) : new Error(failure));
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
