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
import "./tool-stubs.ts";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });

export class Scratch {
  readonly root: string;
  private readonly dir: string;

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

  get parent(): string {
    return this.dir;
  }

  get launch(): string {
    return join(this.root, "packages", "extension", "src", "launch.ts");
  }

  fleet(args: readonly string[], env: Record<string, string> = {}): string {
    return execFileSync("node", [this.launch, ...args], {
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
  }

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

export function mateArgs(h: Harness): string[] {
  const drop = new Set(["--no-extensions", "--no-approve"]);
  return ["--approve", ...h.piArgs().filter((arg) => !drop.has(arg))];
}

export function settingsArgs(h: Harness): string[] {
  const args = mateArgs(h);
  return args.filter(
    (arg, index) =>
      !["--provider", "--model"].includes(arg) &&
      !["--provider", "--model"].includes(args[index - 1] ?? ""),
  );
}

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

export async function startMain(
  lab: HerdrLab,
  scratch: Scratch,
  h: Harness,
  restart = false,
  args: readonly string[] = mateArgs(h),
): Promise<string> {
  const listed = records((await lab.run(["workspace", "list"]))["workspaces"]);
  const existing = listed.find((each) => each["label"] === "1stmate");
  let pane: string;
  if (existing === undefined) {
    const created = await lab.run([
      "workspace",
      "create",
      "--cwd",
      scratch.root,
      "--label",
      "main",
      "--no-focus",
    ]);
    pane = String(records([created["root_pane"]])[0]?.["pane_id"]);
  } else {
    const panes = await lab.run(["pane", "list", "--workspace", String(existing["workspace_id"])]);
    pane = String(records(panes["panes"])[0]?.["pane_id"]);
  }
  const probe = ["-e", fileURLToPath(new URL("./probe.ts", import.meta.url))];
  const command = [...(restart ? ["--continue"] : []), ...args, ...probe]
    .map((arg) => `'${arg}'`)
    .join(" ");
  await lab.submit(pane, `cd '${scratch.root}' && pi ${command}`);
  return pane;
}
