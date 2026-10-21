import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const FRESH = "fresh.txt";

export function installFakeLoader(agentDir: string): void {
  mkdirSync(join(agentDir, "optchat"), { recursive: true });
  mkdirSync(join(agentDir, "extensions", "fm-optchat"), { recursive: true });
  writeFileSync(
    join(agentDir, "optchat", "package.mjs"),
    [
      'import { existsSync, realpathSync } from "node:fs";',
      'import { join } from "node:path";',
      "export function verifyPackage(directory) {",
      `  if (!existsSync(join(realpathSync(directory), ${JSON.stringify(FRESH)}))) throw new Error("OptChat patched fingerprint differs: src/index.ts");`,
      "}",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(agentDir, "extensions", "fm-optchat", "index.ts"),
    "export default function () {}\n",
  );
}

export function preparePackage(directory: string, fresh: boolean): void {
  mkdirSync(directory, { recursive: true });
  if (fresh) writeFileSync(join(directory, FRESH), "prepared\n");
}
