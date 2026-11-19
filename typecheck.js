import { spawnSync } from "node:child_process";
import console from "node:console";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { projects } from "./projects.js";

const compiler = fileURLToPath(import.meta.resolve("tsrs/package.json")).replace(
  /package.json$/,
  "bin/tsrs",
);

function typecheck() {
  for (const project of projects()) {
    const result = spawnSync(process.execPath, [compiler, "-p", project], { stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.signal || result.status === null)
      throw new Error(`tsrs did not exit normally for ${project}.`);
    if (result.status !== 0) return result.status;
  }
  return 0;
}

try {
  process.exitCode = typecheck();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
