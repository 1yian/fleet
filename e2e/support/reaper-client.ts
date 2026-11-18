import { Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { spawnOwned } from "./marked.ts";

const REAPER = fileURLToPath(new URL("./reaper.ts", import.meta.url));
let reaper: ReturnType<typeof spawnOwned> | undefined;

export function tell(message: string): void {
  if (reaper === undefined) {
    reaper = spawnOwned("node", [REAPER], { stdio: ["pipe", "ignore", "inherit"] });
    reaper.unref();
    reaper.stdin?.on("error", () => undefined);
    if (reaper.stdin instanceof Socket) reaper.stdin.unref();
  }
  reaper.stdin?.write(`${message}\n`);
}

export function guardScope(scope: string): void {
  tell(`scope ${JSON.stringify(scope)}`);
}

export function guardRoot(root: string, scope: string): void {
  guardScope(scope);
  tell(`root ${JSON.stringify(root)}`);
}
