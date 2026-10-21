import { execFileSync } from "node:child_process";

const LAVISH_FLOOR = "0.1.80";
const INSTALL = "npm install -g lavish-axi";

const versionParts = (text: string): number[] | undefined =>
  /^(\d+)\.(\d+)\.(\d+)$/.exec(text.trim())?.slice(1).map(Number);

function atLeast(found: readonly number[], floor: readonly number[]): boolean {
  for (const [index, part] of floor.entries()) {
    const have = found[index] ?? 0;
    if (have !== part) return have > part;
  }
  return true;
}

export function lavishProblem(): string | undefined {
  const need = `The fleet needs lavish-axi ${LAVISH_FLOOR} or later on every host. Install it with: ${INSTALL}`;
  let version: string;
  try {
    version = execFileSync("lavish-axi", ["--version"], { encoding: "utf8", timeout: 30_000 });
  } catch {
    return `lavish-axi is missing on this host. ${need}`;
  }
  const found = versionParts(version);
  const floor = versionParts(LAVISH_FLOOR) ?? [];
  if (found !== undefined && atLeast(found, floor)) return undefined;
  return `lavish-axi ${version.trim() || "(no version)"} is too old. ${need}`;
}
