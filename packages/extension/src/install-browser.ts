import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { piAgentDir } from "./tiers-config.ts";

function link(source: string, target: string): void {
  if (
    lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink() &&
    readlinkSync(target) === source
  )
    return;
  const parent = dirname(target);
  mkdirSync(parent, { recursive: true });
  const staged = mkdtempSync(join(parent, ".fleet-browser-"));
  try {
    const next = join(staged, "link");
    symlinkSync(source, next);
    renameSync(next, target);
  } finally {
    rmSync(staged, { recursive: true, force: true });
  }
}

export function installBrowser(root: string): string {
  const browser = join(root, "packages", "fleet-browser");
  if (!existsSync(join(browser, "dist", "cli", "main.js")))
    throw new Error(`the browser build is missing from ${browser}`);
  const cli = join(homedir(), ".local", "bin", "fleet-browser");
  const skill = join(piAgentDir(), "skills", "fleet-browser");
  const source = join(browser, "skills", "fleet-browser");
  if (lstatSync(skill, { throwIfNoEntry: false })?.isDirectory())
    link(join(source, "SKILL.md"), join(skill, "SKILL.md"));
  else link(source, skill);
  link(join(browser, "bin", "fleet-browser.js"), cli);
  return "CLI and skill linked";
}
