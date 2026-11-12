import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { quote } from "@fleet/protocol/route";
import { filesSettings } from "../lane-config.ts";
import { launchWords } from "./invoke.ts";
import type { World } from "./world.ts";
import { pinnedYazi, YAZI_VERSION } from "./yazi-release.ts";

const GUARD_PLUGIN = fileURLToPath(new URL("./yazi/fleet-guard.yazi", import.meta.url));
const INIT_LUA = fileURLToPath(new URL("./yazi/init.lua", import.meta.url));

const stateDir = (home: string): string => join(home, "state", "files");

function writeWrapper(home: string): string {
  const file = join(stateDir(home), "bin", "ff");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `#!/bin/sh\nexec ${launchWords("files")} "$@"\n`);
  chmodSync(file, 0o755);
  return file;
}

interface Key {
  readonly on: string | readonly string[];
  readonly run: string;
  readonly desc: string;
}

const GUARDED: readonly (readonly [string, string, string])[] = [
  ["r", "rename", "Rename (refused in a guarded place)"],
  ["a", "create", "Create (refused in a guarded place)"],
  ["d", "remove", "Trash (refused in a guarded place)"],
  ["D", "remove --permanently", "Delete (refused in a guarded place)"],
  ["p", "paste", "Paste (refused in a guarded place)"],
  ["-", "link", "Symlink (refused in a guarded place)"],
  ["_", "link --relative", "Relative symlink (refused in a guarded place)"],
];

function keys(world: World, ff: string): Key[] {
  const { home } = world;
  const go = (name: string, path: string, desc: string): Key => ({
    on: ["g", name],
    run: `cd ${JSON.stringify(path)}`,
    desc,
  });
  const dynamic = (name: string, folder: string, desc: string): Key => ({
    on: ["g", name],
    run: `shell -- ${quote(ff)} goto ${folder}`,
    desc,
  });
  const block = (on: string | readonly string[], verb: string, desc: string): Key => ({
    on,
    run: `shell --block -- ${quote(ff)} ${verb}`,
    desc,
  });
  return [
    ...GUARDED.map(([on, command, desc]) => ({
      on,
      run: `plugin fleet-guard -- ${command}`,
      desc,
    })),
    go("h", home, "Lane home"),
    go("d", join(home, "data"), "Lane data"),
    go("c", join(home, "config"), "Lane config"),
    go("s", join(home, "state"), "Lane state"),
    dynamic("r", "reports", "Reports"),
    dynamic("k", "skills", "Skills"),
    block(["g", "p"], "pick clone", "Pick a project clone or scratch worktree"),
    block(["g", "w"], "pick worktree", "Pick a worker worktree or scratch worktree"),
    block("E", "edit %h", "Edit this file in the scratch worktree"),
    block("S", "show lane %h", "Show this to this lane's mate"),
    block("M", "show main %h", "Show this to main"),
    block("R", "reload lane", "Reload this lane's mate when it is idle"),
    block("<C-r>", "reload main", "Reload main when it is idle"),
    block("P", "push %h", "Push the scratch branch"),
  ];
}

const toml = (key: Key): string =>
  `[[mgr.prepend_keymap]]\non = ${JSON.stringify(key.on)}\nrun = ${JSON.stringify(key.run)}\ndesc = ${JSON.stringify(key.desc)}\n`;

function yaziToml(world: World, ff: string): string {
  const previews = filesSettings(world.lane).previews;
  const opener = JSON.stringify(`${quote(ff)} open %s1`);
  return [
    "[mgr]",
    "show_hidden = true",
    "show_symlink = true",
    "sort_dir_first = true",
    ...(previews ? [] : ["ratio = [1, 4, 0]"]),
    "",
    "[opener]",
    `fleet = [{ run = ${opener}, block = true, desc = "Open, guarded files read-only", for = "unix" }]`,
    "",
    "[open]",
    'prepend_rules = [{ url = "*", use = "fleet" }]',
    "",
  ].join("\n");
}

function writeConfig(world: World, ff: string): string {
  const dir = join(stateDir(world.home), "yazi");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "plugins"), { recursive: true });
  cpSync(GUARD_PLUGIN, join(dir, "plugins", "fleet-guard.yazi"), { recursive: true });
  cpSync(INIT_LUA, join(dir, "init.lua"));
  writeFileSync(join(dir, "yazi.toml"), yaziToml(world, ff));
  writeFileSync(join(dir, "keymap.toml"), keys(world, ff).map(toml).join("\n"));
  return dir;
}

const missing = (run: SpawnSyncReturns<Buffer>): boolean =>
  run.error !== undefined && "code" in run.error && run.error.code === "ENOENT";

async function yaziFolder(): Promise<string | undefined> {
  try {
    return await pinnedYazi();
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    console.error(`fleet files: could not fetch yazi ${YAZI_VERSION}: ${why}`);
    return undefined;
  }
}

const NO_YAZI = `fleet files: no yazi to run. Check this host can reach github.com and run fleet files again; the lane's files are still on disk`;

export async function launchExplorer(world: World): Promise<number> {
  const ff = writeWrapper(world.home);
  const folder = await yaziFolder();
  const path = process.env["PATH"] ?? "";
  const env = {
    ...process.env,
    PATH: folder === undefined ? path : [folder, path].join(delimiter),
    YAZI_CONFIG_HOME: writeConfig(world, ff),
    FLEET_FILES_HOME: world.home,
    FLEET_FILES_BIN: ff,
  };
  const yazi = spawnSync("yazi", [world.home], { stdio: "inherit", env });
  if (!missing(yazi)) return yazi.status ?? 1;
  console.error(NO_YAZI);
  return 1;
}
