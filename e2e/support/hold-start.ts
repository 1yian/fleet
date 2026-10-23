import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const gateOf = (argvFile: string): string => join(dirname(argvFile), "start-gate");

export default async function holdStart(): Promise<void> {
  const gate = gateOf(process.env["FLEET_ARGV_FILE"] ?? "");
  if (existsSync(gate)) await readFile(gate);
}
