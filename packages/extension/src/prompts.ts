import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../prompts/${name}.md`, import.meta.url)), "utf8");

export const WORKER_PROMPT = read("worker");

export const STOW_PROMPT = read("stow").trim();
