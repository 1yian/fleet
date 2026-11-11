import { spawnSync } from "node:child_process";
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { basename } from "node:path";
import { decide, type Decision } from "./places.ts";
import type { World } from "./world.ts";

const MAX_EDIT_BYTES = 2 * 1024 * 1024;
const SNIFF_BYTES = 8192;
const EDITORS = ["nvim", "vim", "vi"];

const FOLLOW_DISK = [
  "-c",
  "set autoread",
  "-c",
  "autocmd CursorHold,FocusGained,BufEnter * silent! checktime",
];

export const vimString = (text: string): string => `'${text.replaceAll("'", "''")}'`;

function statusLine(note: string): string[] {
  const line = `%f %m%r  ${note.replaceAll("%", "%%")}`;
  return ["-c", "set laststatus=2", "-c", `let &statusline = ${vimString(line)}`];
}

export function editorArgs(decision: Decision, path: string, scratchNote?: string): string[] {
  const banner = decision.editable
    ? scratchNote === undefined
      ? []
      : statusLine(`SCRATCH, ${scratchNote}`)
    : [
        "-R",
        "-M",
        ...statusLine(
          `GUARDED, ${decision.why}. In Files: E opens a scratch copy, S shows it to the mate`,
        ),
      ];
  return [...banner, ...FOLLOW_DISK, "--", path];
}

function hasNul(path: string): boolean {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(SNIFF_BYTES);
    const read = readSync(fd, buffer, 0, SNIFF_BYTES, 0);
    return buffer.subarray(0, read).includes(0);
  } finally {
    closeSync(fd);
  }
}

export function notTextBecause(path: string): string | undefined {
  const { size } = statSync(path);
  if (size > MAX_EDIT_BYTES) return `larger than ${String(MAX_EDIT_BYTES / 1024 / 1024)} MiB`;
  return hasNul(path) ? "a binary file" : undefined;
}

function showMetadata(path: string, because: string): void {
  const { size, mtime } = statSync(path);
  const kind = spawnSync("file", ["-b", path], { encoding: "utf8" });
  console.log(path);
  console.log(`not opened in a text editor: ${because}`);
  console.log(`size ${String(size)} bytes, modified ${mtime.toISOString()}`);
  if (kind.status === 0) console.log(`type ${kind.stdout.trim()}`);
  if (process.stdin.isTTY) {
    process.stdout.write("press Enter to go back ");
    spawnSync("sh", ["-c", "read line"], { stdio: "inherit" });
  }
}

export function runEditor(args: readonly string[], cwd?: string): number {
  for (const editor of EDITORS) {
    const run = spawnSync(editor, args, {
      stdio: "inherit",
      ...(cwd === undefined ? {} : { cwd }),
    });
    const missing = run.error !== undefined && "code" in run.error && run.error.code === "ENOENT";
    if (!missing) return run.status ?? 1;
  }
  console.error(`fleet files: no editor found (tried ${EDITORS.join(", ")}): install nvim`);
  return 1;
}

export function openFile(world: World, path: string): number {
  if (statSync(path).isDirectory()) {
    console.error(`fleet files: ${basename(path)} is a folder`);
    return 1;
  }
  const because = notTextBecause(path);
  if (because !== undefined) {
    showMetadata(path, because);
    return 0;
  }
  return runEditor(editorArgs(decide(world, path), path));
}
