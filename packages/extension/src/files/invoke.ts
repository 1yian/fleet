import { fileURLToPath } from "node:url";
import { quote } from "@fleet/protocol/route";

const LAUNCH = fileURLToPath(new URL("../launch.ts", import.meta.url));

export const launchWords = (...words: readonly string[]): string =>
  [quote(process.execPath), quote(LAUNCH), ...words].join(" ");
