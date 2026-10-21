import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../prompts/${name}.md`, import.meta.url)), "utf8");

export const ROLE_PROMPTS: Readonly<Record<"mate" | "worker", string>> = {
  mate: read("mate"),
  worker: read("worker"),
};
