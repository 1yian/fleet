import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCES = ["../../extension/src/", "./"].map((path) =>
  fileURLToPath(new URL(path, import.meta.url)),
);

function sourcesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return entry.name === "vendor" ? [] : sourcesUnder(path);
      return entry.name.endsWith(".ts") ? [path] : [];
    })
    .sort();
}

export function viewerBuild(): string {
  const hash = createHash("sha256");
  for (const root of SOURCES)
    for (const file of sourcesUnder(root)) {
      hash.update(relative(root, file));
      hash.update("\0");
      hash.update(readFileSync(file));
      hash.update("\0");
    }
  return hash.digest("hex").slice(0, 12);
}
