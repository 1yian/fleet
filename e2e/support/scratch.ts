// A scratch copy of this repository, for tests that start the fleet the way the captain does:
// a Pi in the repo (main's home) and lane homes that are worktrees of it. Nothing touches the
// real checkout, its worktrees, or the live fleet. The copy holds the working tree as it is now,
// committed on its own, and shares the real node_modules.
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Harness } from "./harness.ts";
import type { HerdrLab } from "./herdr.ts";
import { records } from "./json.ts";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });

export class Scratch {
  readonly root: string;
  private readonly dir: string;

  /**
   * A copy of the repository at `<dir>/<name>`, with lane homes next to it in `<name>.worktrees`.
   * `<dir>` is a new folder in `base`. A home that holds a memory profile needs a short `base`,
   * because the profile's socket path must fit 103 bytes on macOS.
   */
  constructor(name = "fleet", base = tmpdir()) {
    this.dir = mkdtempSync(join(base, "fleet-scratch-"));
    this.root = join(this.dir, name);
    mkdirSync(this.root, { recursive: true });
    const files = git(REPO, "ls-files", "--cached", "--others", "--exclude-standard", "-z")
      .split("\0")
      .filter((file) => file !== "" && existsSync(join(REPO, file)));
    for (const file of files) {
      mkdirSync(dirname(join(this.root, file)), { recursive: true });
      cpSync(join(REPO, file), join(this.root, file));
    }
    symlinkSync(join(REPO, "node_modules"), join(this.root, "node_modules"));
    git(this.root, "init", "-q", "-b", "main");
    git(this.root, "add", "-A");
    git(
      this.root,
      "-c",
      "user.name=scratch",
      "-c",
      "user.email=scratch@example.com",
      "commit",
      "-qm",
      "scratch",
    );
  }

  /** The folder that holds this copy and its lane homes, such as to put a second copy in. */
  get parent(): string {
    return this.dir;
  }

  /** The `fleet` command of this copy. */
  get launch(): string {
    return join(this.root, "packages", "extension", "src", "launch.ts");
  }

  /** Runs `fleet <args>` of this copy, and returns what it printed. */
  fleet(args: readonly string[], env: Record<string, string> = {}): string {
    return execFileSync("node", [this.launch, ...args], {
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
  }

  /** Makes a second mate's home: a worktree of this copy. Returns its path. */
  addLane(
    lane: string,
    settings: {
      url: string;
      token: string;
      args?: readonly string[];
      hosts?: unknown;
      roots?: unknown;
      direnv?: string;
    },
  ): string {
    const args = ["home", "add", lane, "--url", settings.url, "--token", settings.token];
    args.push("--args", JSON.stringify(settings.args ?? []));
    args.push(
      "--hosts",
      JSON.stringify(settings.hosts ?? {}),
      "--roots",
      JSON.stringify(settings.roots ?? {}),
    );
    if (settings.direnv !== undefined) args.push("--direnv", settings.direnv);
    return this.fleet(args).trim();
  }

  dispose(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}

/**
 * Pi arguments for a mate in a scratch home: the harness's fake model, with the repo's own
 * .pi/settings.json trusted and loaded instead of switched off.
 */
export function mateArgs(h: Harness): string[] {
  const drop = new Set(["--no-extensions", "--no-approve"]);
  return ["--approve", ...h.piArgs().filter((arg) => !drop.has(arg))];
}

/**
 * Like `mateArgs`, without the fake model's --provider and --model, so the Pi picks its model from its
 * settings the way the captain's does: the folder's .pi/settings.json, else the agent folder's.
 */
export function settingsArgs(h: Harness): string[] {
  const args = mateArgs(h);
  return args.filter(
    (arg, index) =>
      !["--provider", "--model"].includes(arg) &&
      !["--provider", "--model"].includes(args[index - 1] ?? ""),
  );
}

/** Writes main's settings into the copy, the file that `fleet migrate` writes: config/lane.json. */
export function configureMain(
  scratch: Scratch,
  url: string,
  token: string,
  more: Record<string, unknown> = {},
): void {
  mkdirSync(join(scratch.root, "config"), { recursive: true });
  const lane = { lane: "main", url, token, ...more };
  writeFileSync(join(scratch.root, "config", "lane.json"), JSON.stringify(lane));
}

/**
 * Starts main the way the captain does: plain `pi` in the repo, in its own herdr workspace. The
 * fake model's arguments stand in for the captain's tier, unless `args` say otherwise, and a
 * restart adds --continue.
 */
export async function startMain(
  lab: HerdrLab,
  scratch: Scratch,
  h: Harness,
  restart = false,
  args: readonly string[] = mateArgs(h),
): Promise<string> {
  const listed = records((await lab.run(["workspace", "list"]))["workspaces"]);
  const existing = listed.find((each) => each["label"] === "fleet-main");
  let pane: string;
  if (existing === undefined) {
    const created = await lab.run([
      "workspace",
      "create",
      "--cwd",
      scratch.root,
      "--label",
      "fleet-main",
      "--no-focus",
    ]);
    pane = String(records([created["root_pane"]])[0]?.["pane_id"]);
  } else {
    const panes = await lab.run(["pane", "list", "--workspace", String(existing["workspace_id"])]);
    pane = String(records(panes["panes"])[0]?.["pane_id"]);
  }
  // The probe reports fleet_connected, which says that this Pi has started and joined the fleet.
  const probe = ["-e", fileURLToPath(new URL("./probe.ts", import.meta.url))];
  const command = [...(restart ? ["--continue"] : []), ...args, ...probe]
    .map((arg) => `'${arg}'`)
    .join(" ");
  await lab.submit(pane, `cd '${scratch.root}' && pi ${command}`);
  return pane;
}
