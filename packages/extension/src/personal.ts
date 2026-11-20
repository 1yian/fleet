import { missingPersonalClone, PERSONAL_PROJECT } from "@fleet/protocol";
import { fleetHostName } from "@fleet/protocol/route";
import { isLocal } from "./host.ts";
import type { Link } from "./link.ts";

export async function dispatchHost(link: Link, host: string, project: string): Promise<string> {
  isLocal(host);
  const registered = await link.call("projects", {});
  const found = registered.find(({ name }) => name === project);
  if (project !== PERSONAL_PROJECT) {
    if (found !== undefined) return host;
    throw new Error(
      `project ${project} is not registered, so nothing was created. board(projects=true) lists the registered projects. Work that fits none of them goes under project "${PERSONAL_PROJECT}", which main's first dispatch creates if not already registered. Never do the work yourself`,
    );
  }
  if (found !== undefined) {
    if (!found.clones.some((clone) => clone.host === host))
      throw missingPersonalClone(host, found.clones);
    return host;
  }
  const bootstrapHost = host === "local" ? fleetHostName() : host;
  isLocal(bootstrapHost);
  await link.call("project.personal", { host: bootstrapHost });
  return bootstrapHost;
}
