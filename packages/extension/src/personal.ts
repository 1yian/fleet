import { PERSONAL_PROJECT } from "@fleet/protocol";
import { onHost } from "./host.ts";
import type { Link } from "./link.ts";
import { SHELL_HOST_DIR } from "./scratch.ts";

const MAKE_PERSONAL_CLONE_SCRIPT = `set -eu
clone=${SHELL_HOST_DIR}/projects/${PERSONAL_PROJECT}
mkdir -p "$clone"
[ -d "$clone/.git" ] || git -C "$clone" init -q -b main
git -C "$clone" rev-parse -q --verify HEAD >/dev/null ||
  git -C "$clone" -c user.name=fleet -c user.email=fleet@localhost commit -q --allow-empty -m "Start the ${PERSONAL_PROJECT} project"
printf '%s\\n' "$clone"`;

export async function requireProject(link: Link, host: string, project: string): Promise<void> {
  const registered = await link.call("projects", {});
  const found = registered.find(({ name }) => name === project);
  if (project !== PERSONAL_PROJECT) {
    if (found !== undefined) return;
    throw new Error(
      `project ${project} is not registered, so nothing was created. board(projects=true) lists the registered projects. Work that fits none of them goes under project "${PERSONAL_PROJECT}", which dispatch makes on first use. Never do the work yourself`,
    );
  }
  if (found?.clones.some((clone) => clone.host === host) === true) return;
  const path = (await onHost(host, ["sh", "-c", MAKE_PERSONAL_CLONE_SCRIPT, "personal"])).trim();
  await link.call("project.personal", { host, path });
}
