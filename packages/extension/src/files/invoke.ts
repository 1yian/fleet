import { fileURLToPath } from "node:url";
import { quote } from "@fleet/protocol/route";

const LAUNCH = fileURLToPath(new URL("../launch.ts", import.meta.url));

export const launchPrefix = (): string[] => [process.execPath, LAUNCH];

export const launchWords = (...words: readonly string[]): string =>
  [...launchPrefix().map(quote), ...words].join(" ");
