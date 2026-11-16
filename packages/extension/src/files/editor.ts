import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { launchPrefix } from "./invoke.ts";
import { decide, type Decision } from "./places.ts";
import type { World } from "./world.ts";

const MAX_EDIT_BYTES = 2 * 1024 * 1024;
const SNIFF_BYTES = 8192;
const EDITORS = ["nvim", "vim", "vi"];
const KEEPS_ITS_OWN_SCRATCH = "nvim";
const VIM_SCRATCH_FOLDERS = { directory: "swap", backupdir: "backup", undodir: "undo" } as const;

const FOLLOW_DISK = [
  "-c",
  "set autoread",
  "-c",
  "autocmd CursorHold,FocusGained,BufEnter * silent! checktime",
];

const vimString = (text: string): string => `'${text.replaceAll("'", "''")}'`;

function statusLine(note: string): string[] {
  const line = `%f %m%r  ${note.replaceAll("%", "%%")}`;
  return ["-c", "set laststatus=2", "-c", `let &statusline = ${vimString(line)}`];
}

const NO_NETRW = ["--cmd", "let g:loaded_netrw = 1 | let g:loaded_netrwPlugin = 1"];

function guardBuffers(): string[] {
  const check = [...launchPrefix(), "files", "check"].map(vimString).join(", ");
  const command = `join(map([${check}, expand('<afile>:p')], 'shellescape(v:val)'), ' ')`;
  return [
    "-c",
    `autocmd BufReadPost,BufNewFile * call system(${command}) | if v:shell_error != 0 | setlocal readonly nomodifiable | endif`,
  ];
}

function vimScratchRoot(): string {
  const named = process.env["XDG_STATE_HOME"];
  const state = named !== undefined && named !== "" ? named : join(homedir(), ".local", "state");
  return join(state, "fleet", "vim");
}

function vimScratch(): string[] {
  const root = vimScratchRoot();
  return Object.entries(VIM_SCRATCH_FOLDERS).flatMap(([option, folder]) => {
    const path = join(root, folder);
    mkdirSync(path, { recursive: true, mode: 0o700 });
    const item = `${path.replaceAll(",", "\\,")}//`;
    return ["--cmd", `let &${option} = ${vimString(item)}`];
  });
}

function sessionBanner(decision: Decision, scratchNote?: string): string[] {
  if (!decision.editable) {
    return [
      "-R",
      "-M",
      ...statusLine(
        `GUARDED, ${decision.why}. In Files: E opens a scratch copy, S shows it to the mate`,
      ),
    ];
  }
  return scratchNote === undefined ? [] : statusLine(`SCRATCH, ${scratchNote}`);
}

function editorArgs(decision: Decision, path: string, scratchNote?: string): string[] {
  return [
    ...NO_NETRW,
    ...sessionBanner(decision, scratchNote),
    ...guardBuffers(),
    ...FOLLOW_DISK,
    "--",
    path,
  ];
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

function notTextBecause(path: string): string | undefined {
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

function runEditor(world: World, args: readonly string[], cwd?: string): number {
  for (const editor of EDITORS) {
    const own = editor === KEEPS_ITS_OWN_SCRATCH ? args : [...vimScratch(), ...args];
    const run = spawnSync(editor, own, {
      stdio: "inherit",
      env: { ...process.env, FLEET_FILES_HOME: world.home },
      ...(cwd === undefined ? {} : { cwd }),
    });
    const missing = run.error !== undefined && "code" in run.error && run.error.code === "ENOENT";
    if (!missing) return run.status ?? 1;
  }
  console.error(`fleet files: no editor found (tried ${EDITORS.join(", ")}): install nvim`);
  return 1;
}

export function showInstead(path: string): number | undefined {
  if (!existsSync(path)) return undefined;
  if (statSync(path).isDirectory()) {
    console.error(`fleet files: ${basename(path)} is a folder`);
    return 1;
  }
  const because = notTextBecause(path);
  if (because === undefined) return undefined;
  showMetadata(path, because);
  return 0;
}

export function openChecked(
  world: World,
  path: string,
  decision: Decision,
  scratchNote?: string,
  cwd?: string,
): number {
  return showInstead(path) ?? runEditor(world, editorArgs(decision, path, scratchNote), cwd);
}

export function openFile(world: World, path: string): number {
  return openChecked(world, path, decide(world, path));
}
