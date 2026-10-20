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

const quote = (arg: string): string => `'${arg.replaceAll("'", `'\\''`)}'`;

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
      if (error !== null && out.trim() === "")
        reject(new Error(`herdr ${args[0] ?? ""} on ${host} failed: ${err || error.message}`));
      else resolve(out);
    });
  });
  const reply: unknown = JSON.parse(stdout);
  if (!isRecord(reply))
    throw new Error(`herdr ${args[0] ?? ""} on ${host} returned no JSON object`);
  if (isRecord(reply["error"])) throw new Error(String(reply["error"]["message"]));
  return isRecord(reply["result"]) ? reply["result"] : {};
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
export { isRecord };
