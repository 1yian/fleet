import { PERSONAL_PROJECT } from "@fleet/protocol";
import { ownHostName } from "./host.ts";
import type { Link } from "./link.ts";

export async function requireProject(link: Link, host: string, project: string): Promise<string> {
  const registered = await link.call("projects", {});
  const found = registered.find(({ name }) => name === project);
  if (project !== PERSONAL_PROJECT) {
    if (found !== undefined) return host;
    throw new Error(
      `project ${project} is not registered, so nothing was created. board(projects=true) lists the registered projects. Work that fits none of them goes under project "${PERSONAL_PROJECT}", which dispatch makes on first use. Never do the work yourself`,
    );
  }
  const named = host === "local" ? ownHostName() : host;
  const clones = found?.clones ?? [];
  const placed = [host, named].find((each) => clones.some((clone) => clone.host === each));
  if (placed !== undefined) return placed;
  await link.call("project.personal", { host: named });
  return named;
}
