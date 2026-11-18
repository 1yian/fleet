import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";

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
