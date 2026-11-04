import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function filesUnder(root: string, skip: (name: string) => boolean): string[] {
  const found: string[] = [];
  for (const name of readdirSync(root)) {
    if (skip(name)) continue;
    const path = join(root, name);
    let info;
    try {
      info = statSync(path);
    } catch {
      continue;
    }
    if (info.isDirectory()) found.push(...filesUnder(path, skip));
    else if (info.isFile()) found.push(path);
  }
  return found;
}

export function filesHolding(
  secrets: readonly string[],
  root: string,
  skip: (name: string) => boolean = () => false,
): string[] {
  return filesUnder(root, skip).filter((file) => {
    let bytes: Buffer;
    try {
      bytes = readFileSync(file);
    } catch {
      return false;
    }
    return secrets.some((secret) => bytes.includes(secret));
  });
}
