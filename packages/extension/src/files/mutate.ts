import { lstatSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { refusals } from "./places.ts";
import type { World } from "./world.ts";

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function allowed(world: World, paths: readonly string[]): void {
  const refused = refusals(world, paths);
  if (refused.length > 0) throw new Error(refused.join("\n"));
}

function vacant(path: string): void {
  if (exists(path)) throw new Error(`${path} already exists`);
}

export function renamePath(world: World, from: string, to: string): void {
  const source = resolve(from);
  const target = resolve(to);
  allowed(world, [source, target]);
  vacant(target);
  renameSync(source, target);
}

export function createPath(world: World, to: string): void {
  const target = resolve(to);
  allowed(world, [target]);
  vacant(target);
  if (to.endsWith("/")) {
    mkdirSync(target, { recursive: true });
    return;
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, "", { flag: "wx" });
}
