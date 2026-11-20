import { hostname } from "node:os";

export function fleetHostName(): string {
  const named = process.env["FLEET_HOST"];
  if (named && named !== "local") return named;
  return hostname().toLowerCase().split(".")[0] ?? "";
}

export function canonicalFleetHost(host: string, configured: boolean): string {
  if (host === "local") return fleetHostName();
  if (configured) return host;
  const native = hostname().toLowerCase();
  const name = host.toLowerCase();
  return name === native || name === native.split(".")[0] ? fleetHostName() : host;
}

const DEFAULT_TOOL_DIRS = [
  "/opt/homebrew/bin",
  "/opt/homebrew/sbin",
  "/usr/local/bin",
  "/usr/local/sbin",
].join(":");

const WITH_TOOL_DIRS = `dirs=$1
shift
IFS=:
for dir in $dirs; do
  case ":$PATH:" in
    *":$dir:"*) ;;
    *) [ -d "$dir" ] && PATH="\${PATH:+$PATH:}$dir" ;;
  esac
done
unset IFS
export PATH
exec "$@"`;

export const quote = (arg: string): string => `'${arg.replaceAll("'", `'\\''`)}'`;

function toolDirs(): string {
  const named = process.env["FLEET_TOOL_DIRS"];
  return named === undefined || named === "" ? DEFAULT_TOOL_DIRS : named;
}

export function routed(route: readonly string[], argv: readonly string[]): string[] {
  if (route.length === 0) return [...argv];
  const command = ["sh", "-c", WITH_TOOL_DIRS, "fleet", toolDirs(), ...argv];
  return [...route, command.map(quote).join(" ")];
}
