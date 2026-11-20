import type { DatabaseSync } from "node:sqlite";
import { PERSONAL_PROJECT } from "@fleet/protocol";
import { addProject, listProjects, setClone } from "./store.ts";

export function ensurePersonalProject(
  db: DatabaseSync,
  host: string,
  path: string,
): { project: string; path: string } {
  const found = listProjects(db).find(({ name }) => name === PERSONAL_PROJECT);
  const registered = found?.clones.find((clone) => clone.host === host);
  if (registered !== undefined) return { project: PERSONAL_PROJECT, path: registered.path };
  if (found === undefined)
    addProject(db, {
      name: PERSONAL_PROJECT,
      delivery: "local-only",
      clones: { [host]: path },
      yolo: false,
      repo: null,
    });
  else setClone(db, PERSONAL_PROJECT, host, path);
  return { project: PERSONAL_PROJECT, path };
}
