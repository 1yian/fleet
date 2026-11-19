import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export function readPromptFile(path: string): string | undefined {
  try {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      return fstatSync(fd).isFile() ? readFileSync(fd, "utf8") : undefined;
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

export function abortWithoutMateContract(ctx: ExtensionContext, path: string): void {
  ctx.abort();
  const message = `Fleet mate run blocked: restore a readable regular file at ${path}, then retry.`;
  if (ctx.hasUI) ctx.ui.setWidget("fleet-mate-contract", [message]);
  else console.error(message);
}
