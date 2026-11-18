import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

export const ROOMY_DISK = {
  type: 0,
  bsize: 4096,
  blocks: 1_000_000,
  bfree: 900_000,
  bavail: 850_000,
  files: 1_000_000,
  ffree: 900_000,
};

if (process.argv[1]?.endsWith("launch.ts") === true && process.argv[2] === "scratch") {
  Reflect.set(fs, "statfsSync", () => ROOMY_DISK);
  syncBuiltinESMExports();
}
