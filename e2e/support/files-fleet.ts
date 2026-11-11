import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { delimiter, join } from "node:path";
import { Cardd } from "./cardd.ts";
import { git } from "./remote.ts";
import { tempDir } from "./run-root.ts";
import { configureMain, Scratch } from "./scratch.ts";

const HOST = "p620";

export interface FilesRun {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface EditorCall {
  readonly cwd: string;
  readonly args: readonly string[];
}

export class FilesFleet {
  readonly cardd: Cardd;
  readonly scratch: Scratch;
  readonly home: string;
  readonly clone: string;
  readonly remote: string;
  readonly userHome: string;
  readonly bin: string;
  readonly editorLog: string;
  readonly released: string;
  readonly mainToken: string;
  readonly laneToken: string;

  private constructor(parts: {
    cardd: Cardd;
    scratch: Scratch;
    home: string;
    clone: string;
    remote: string;
    mainToken: string;
    laneToken: string;
  }) {
    this.cardd = parts.cardd;
    this.scratch = parts.scratch;
    this.home = parts.home;
    this.clone = parts.clone;
    this.remote = parts.remote;
    this.mainToken = parts.mainToken;
    this.laneToken = parts.laneToken;
    this.userHome = tempDir("files-user-");
    this.bin = tempDir("files-bin-");
    this.editorLog = join(this.bin, "editor.log");
    this.released = join(tempDir("files-store-"), "skills");
    this.installEditor();
    this.installReleasedSkills();
  }

  static async start(
    options: { lane?: string; laneArgs?: readonly string[] } = {},
  ): Promise<FilesFleet> {
    const cardd = await Cardd.start();
    const scratch = new Scratch();
    const remote = join(scratch.parent, "fleet.git");
    execFileSync("git", ["clone", "-q", "--bare", scratch.root, remote]);
    git(scratch.root, "remote", "add", "origin", remote);
    git(scratch.root, "fetch", "-q", "origin");
    const clone = join(scratch.parent, "fleet-clone");
    execFileSync("git", ["clone", "-q", remote, clone]);
    const mainToken = cardd.addLane("main", undefined, scratch.root);
    configureMain(scratch, cardd.url, mainToken, { host: HOST });
    const lane = options.lane ?? "cleo";
    const laneToken = cardd.addLane(lane, "main");
    const home = scratch.addLane(lane, {
      url: cardd.url,
      token: laneToken,
      host: HOST,
      args: options.laneArgs ?? [],
    });
    cardd.addProject("fleet", { [HOST]: clone }, "acme/fleet", "direct-PR");
    return new FilesFleet({ cardd, scratch, home, clone, remote, mainToken, laneToken });
  }

  private installEditor(): void {
    const stub = join(this.bin, "nvim");
    writeFileSync(
      stub,
      '#!/bin/sh\nprintf \'%s\\n\' "@@@call" "$(pwd)" "$@" >> "$FILES_EDITOR_LOG"\n',
    );
    chmodSync(stub, 0o755);
  }

  private installReleasedSkills(): void {
    mkdirSync(join(this.released, "lavish"), { recursive: true });
    writeFileSync(
      join(this.released, "lavish", "SKILL.md"),
      "---\nname: lavish\ndescription: released lavish\n---\nreleased body\n",
    );
    const agents = join(this.userHome, ".agents");
    mkdirSync(agents, { recursive: true });
    symlinkSync(this.released, join(agents, "skills"));
  }

  env(extra: Record<string, string> = {}): Record<string, string> {
    return {
      FLEET_FILES_HOME: this.home,
      FILES_EDITOR_LOG: this.editorLog,
      HOME: this.userHome,
      PI_CODING_AGENT_DIR: join(this.userHome, ".pi", "agent"),
      PATH: [this.bin, process.env["PATH"] ?? ""].join(delimiter),
      ...extra,
    };
  }

  files(args: readonly string[], extra: Record<string, string> = {}, cwd?: string): FilesRun {
    const run = spawnSync("node", [this.scratch.launch, "files", ...args], {
      encoding: "utf8",
      env: { ...process.env, ...this.env(extra) },
      ...(cwd === undefined ? {} : { cwd }),
    });
    return { status: run.status ?? -1, stdout: run.stdout, stderr: run.stderr };
  }

  editorCalls(): EditorCall[] {
    if (!existsSync(this.editorLog)) return [];
    const text = readFileSync(this.editorLog, "utf8");
    const calls: { cwd: string; args: string[] }[] = [];
    let fresh = false;
    for (const line of text.split("\n").slice(0, -1)) {
      if (line === "@@@call") {
        calls.push({ cwd: "", args: [] });
        fresh = true;
        continue;
      }
      const call = calls.at(-1);
      if (call === undefined) continue;
      if (fresh) call.cwd = line;
      else call.args.push(line);
      fresh = false;
    }
    return calls;
  }

  forgetEditorCalls(): void {
    rmSync(this.editorLog, { force: true });
  }

  async stop(): Promise<void> {
    await this.cardd.stop();
    this.scratch.dispose();
  }
}
