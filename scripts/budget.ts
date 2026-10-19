// Line counts against the new-code limits of spec section 24.2.
// Run: node scripts/budget.ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const PARTS = [
  { name: "fleet extension", limit: 1900, roots: ["packages/extension/src"] },
  {
    name: "cardd (with protocol and schema)",
    limit: 600,
    roots: ["packages/cardd/src", "packages/cardd/migrations", "packages/protocol/src"],
  },
  { name: "board", limit: 1500, roots: ["packages/board/src"] },
  { name: "end-to-end tests", limit: 1000, roots: ["e2e"] },
];

function lines(path: string): number {
  if (path.includes("node_modules")) return 0;
  let stats;
  try {
    stats = statSync(path);
  } catch {
    return 0;
  }
  if (stats.isDirectory())
    return readdirSync(path).reduce((sum, name) => sum + lines(join(path, name)), 0);
  return /\.(ts|tsx|sql)$/.test(path) ? readFileSync(path, "utf8").split("\n").length - 1 : 0;
}

let total = 0;
for (const part of PARTS) {
  const count = part.roots.reduce((sum, root) => sum + lines(root), 0);
  total += count;
  console.log(`${part.name.padEnd(36)} ${String(count).padStart(5)} / ${String(part.limit)}`);
}
console.log(`${"total".padEnd(36)} ${String(total).padStart(5)} / 5000`);
