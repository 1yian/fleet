import { readFileSync } from "node:fs";
import { join } from "node:path";
import { existingHome, laneHomes, reconfigure } from "./homes.ts";
import { onHost } from "./host.ts";
import { isRecord, LANE_FILE, readLaneConfig } from "./lane-config.ts";

export async function homeTransport(
  root: string,
  args: readonly string[],
  options: { readonly from?: string; readonly check?: boolean },
): Promise<string[]> {
  const [host, target] = args;
  if (args.length === 1 && host !== undefined && options.check === true) {
    if (Object.keys(options).some((key) => key !== "check"))
      throw new Error("home transport --check takes no other options");
    return [await onHost(host, ["printf", "fleet-transport-ok"], 30_000)];
  }
  if (args.length !== 2 || host === undefined || target === undefined || options.from === undefined)
    throw new Error(
      "usage: fleet home transport <host> <lane|all> --from <reference-lane>, or fleet home transport <host> --check",
    );
  if (Object.keys(options).some((key) => key !== "from"))
    throw new Error("home transport takes only --from");
  return setHomeTransport(root, host, options.from, target);
}

function mapping(root: string, lane: string, host: string) {
  const config = readLaneConfig(existingHome(root, lane));
  const via = config?.hosts[host];
  if (
    !Array.isArray(via) ||
    via.length === 0 ||
    !via.every((part): part is string => typeof part === "string" && part.trim() !== "")
  )
    throw new Error(`${lane}: no supported transport for ${host}; expected a nonempty argv`);
  const remoteRoot = config?.roots[host];
  if (remoteRoot?.trim() === "")
    throw new Error(`${lane}: unsupported Fleet root for ${host}; expected a nonempty folder`);
  return { via, remoteRoot };
}

function setHomeTransport(root: string, host: string, reference: string, target: string): string[] {
  const { via, remoteRoot } = mapping(root, reference, host);
  const homes =
    target === "all"
      ? laneHomes(root).map(({ lane, home }) => ({ lane, home }))
      : [{ lane: target, home: existingHome(root, target) }];
  if (homes.length === 0) throw new Error("no lane homes on this host");
  return homes.map(({ lane, home }) => {
    const current: unknown = JSON.parse(readFileSync(join(home, LANE_FILE), "utf8"));
    if (!isRecord(current)) throw new Error(`${lane}: lane settings are not an object`);
    const hosts = isRecord(current["hosts"]) ? current["hosts"] : {};
    const roots = isRecord(current["roots"]) ? current["roots"] : {};
    const changes = {
      hosts: { ...hosts, [host]: via },
      ...(remoteRoot === undefined ? {} : { roots: { ...roots, [host]: remoteRoot } }),
    };
    const same =
      JSON.stringify(hosts[host]) === JSON.stringify(via) &&
      (remoteRoot === undefined || roots[host] === remoteRoot);
    if (!same) reconfigure(home, changes);
    return `${lane}: ${host} transport ${same ? "unchanged" : "merged"}. Running mates are unchanged; main must approve replacement before runtime verification`;
  });
}
