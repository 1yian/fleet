import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fleetHostName } from "@fleet/protocol/route";
import { sidebarHostName } from "./arrange.ts";
import { ownHostName } from "./host.ts";
import type { LaneConfig } from "./lane-config.ts";
import { processId } from "./process-id.ts";

const FIRST_PASS_FLAG = "fleet-first-pass-hosts";
export const FIRST_PASS_ARG = `--${FIRST_PASS_FLAG}=`;

export function registerFirstPassFlag(pi: ExtensionAPI): void {
  pi.registerFlag(FIRST_PASS_FLAG, {
    type: "string",
    description:
      "The hosts of the scoped update that relaunched main: its first startup pass reaches only them",
  });
}

export const firstPassFlagValue = (hosts: readonly string[]): string => JSON.stringify(hosts);

function parseHosts(given: string): string[] {
  try {
    const parsed: unknown = JSON.parse(given);
    return Array.isArray(parsed) &&
      parsed.length > 0 &&
      parsed.every((host): host is string => typeof host === "string" && host !== "")
      ? parsed
      : [];
  } catch {
    return [];
  }
}

export function firstPassHosts(pi: ExtensionAPI): string[] | undefined {
  const given = pi.getFlag(FIRST_PASS_FLAG);
  return typeof given === "string" ? parseHosts(given) : undefined;
}

export const announcedIdentity = (role: string): { process: string; host?: string } => ({
  process: processId(),
  ...(role === "mate" ? { host: sidebarHostName(process.env["FLEET_HOST"]) } : {}),
});

export function hostNamesOf(config: LaneConfig, hosts: readonly string[]): string[] {
  const names = hosts.flatMap((host) =>
    host === "local"
      ? [
          "local",
          fleetHostName(),
          ownHostName(),
          sidebarHostName(process.env["FLEET_HOST"]),
        ].filter((name) => name !== "" && !Object.hasOwn(config.hosts, name))
      : [host],
  );
  return [...new Set(names)];
}
