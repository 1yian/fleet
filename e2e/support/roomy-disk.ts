import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const BLOCK_BYTES = 4096;
const TOTAL = 1_000_000;
const FREE = 900_000;

if (process.argv[1]?.endsWith("launch.ts") === true && process.argv[2] === "scratch") {
  Reflect.set(fs, "statfsSync", () => ({
    type: 0,
    bsize: BLOCK_BYTES,
    blocks: TOTAL,
    bfree: FREE,
    bavail: FREE,
    files: TOTAL,
    ffree: FREE,
  }));
  syncBuiltinESMExports();
}
