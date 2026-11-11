import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FilesFleet } from "./files-fleet.ts";
import { Harness } from "./harness.ts";
import { HerdrLab } from "./herdr.ts";
import { isRecord, parseRecord, records, type JsonRecord } from "./json.ts";
import { mateArgs } from "./scratch.ts";
import { tempDir } from "./run-root.ts";

const WAIT_MS = 60_000;
const BIN = fileURLToPath(new URL("../../node_modules/.bin", import.meta.url));

export async function until<T>(
  what: string,
  read: () => T | undefined | Promise<T | undefined>,
): Promise<T> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

function installYazi(folder: string, userHome: string, kind: "stub" | "real"): void {
  const wrapper = join(folder, "yazi");
  const body =
    kind === "stub"
      ? 'echo "FILES-TAB-STUB in $1"\nexec sleep 3600'
      : `export HOME='${userHome}'\nexec '${execFileSync("sh", ["-c", "command -v yazi"], { encoding: "utf8" }).trim()}' "$@"`;
  writeFileSync(wrapper, `#!/bin/sh\n${body}\n`);
  chmodSync(wrapper, 0o755);
}

function addFilesConfig(home: string, files: Record<string, unknown>): void {
  const laneFile = join(home, "config", "lane.json");
  const config = parseRecord(readFileSync(laneFile, "utf8"));
  writeFileSync(laneFile, JSON.stringify({ ...config, files }));
}

export class FilesMates {
  readonly fleet: FilesFleet;
  readonly h: Harness;
  readonly lab: HerdrLab;
  readonly stubs: string;
  readonly lane: string;

  private constructor(parts: {
    fleet: FilesFleet;
    h: Harness;
    lab: HerdrLab;
    stubs: string;
    lane: string;
  }) {
    this.fleet = parts.fleet;
    this.h = parts.h;
    this.lab = parts.lab;
    this.stubs = parts.stubs;
    this.lane = parts.lane;
  }

  static async start(
    options: {
      lane?: string;
      files?: Record<string, unknown>;
      laneArgs?: (h: Harness) => string[];
      yazi?: "stub" | "real";
    } = {},
  ): Promise<FilesMates> {
    const h = await Harness.start();
    const lane = options.lane ?? "cleo";
    const stubs = tempDir("files-mates-");
    const cleanups: (() => Promise<void>)[] = [() => h.stop()];
    try {
      mkdirSync(join(h.dir, "agent", "extensions"), { recursive: true });
      execFileSync("herdr", ["integration", "install", "pi"], {
        env: { ...process.env, PI_CODING_AGENT_DIR: join(h.dir, "agent") },
      });
      const fleet = await FilesFleet.start({
        lane,
        laneArgs: options.laneArgs?.(h) ?? mateArgs(h),
      });
      cleanups.push(() => fleet.stop());
      installYazi(stubs, fleet.userHome, options.yazi ?? "stub");
      addFilesConfig(fleet.home, options.files ?? {});
      const path = [stubs, fleet.bin, BIN, process.env["PATH"] ?? ""].join(delimiter);
      const lab = await HerdrLab.start({
        ...h.piEnv("mate"),
        FILES_EDITOR_LOG: fleet.editorLog,
        PATH: path,
      });
      return new FilesMates({ fleet, h, lab, stubs, lane });
    } catch (error) {
      await Promise.allSettled(cleanups.map((cleanup) => cleanup()));
      throw error;
    }
  }

  up(): JsonRecord[] {
    const out = this.fleet.scratch.fleet(["up", "--json"], {
      ...this.lab.env,
      HERDR_SESSION: this.lab.name,
    });
    const parsed: unknown = JSON.parse(out);
    return Array.isArray(parsed) ? parsed.filter(isRecord) : [];
  }

  async workspace(label: string): Promise<string | undefined> {
    const spaces = records((await this.lab.run(["workspace", "list"]))["workspaces"]);
    const found = spaces.find((each) => each["label"] === label);
    return found === undefined ? undefined : String(found["workspace_id"]);
  }

  async tabs(workspace: string): Promise<JsonRecord[]> {
    return records((await this.lab.run(["tab", "list", "--workspace", workspace]))["tabs"]);
  }

  async filesPane(workspace: string): Promise<string | undefined> {
    const tab = (await this.tabs(workspace)).find((each) => each["label"] === "Files");
    if (tab === undefined) return undefined;
    const panes = records(
      (await this.lab.run(["pane", "list", "--workspace", workspace]))["panes"],
    );
    const pane = panes.find((each) => each["tab_id"] === tab["tab_id"]);
    return pane === undefined ? undefined : String(pane["pane_id"]);
  }

  async mainPane(): Promise<string> {
    const created = await this.lab.run([
      "workspace",
      "create",
      "--cwd",
      this.fleet.scratch.root,
      "--label",
      "main",
      "--no-focus",
    ]);
    const pane = String(records([created["root_pane"]])[0]?.["pane_id"]);
    const args = mateArgs(this.h)
      .map((arg) => `'${arg}'`)
      .join(" ");
    await this.lab.submit(
      pane,
      `cd '${this.fleet.scratch.root}' && FLEET_FAKE_AGENT=main pi ${args}`,
    );
    return pane;
  }

  async matePane(): Promise<string> {
    const workspace = await until("the mate's workspace", () =>
      this.workspace(`2ndmate-${this.lane}`),
    );
    const panes = records(
      (await this.lab.run(["pane", "list", "--workspace", workspace]))["panes"],
    );
    const filesTab = (await this.tabs(workspace)).find((each) => each["label"] === "Files");
    const pane = panes.find((each) => each["tab_id"] !== filesTab?.["tab_id"]);
    assert.ok(pane !== undefined, "the mate has a pane");
    return String(pane["pane_id"]);
  }

  async stop(): Promise<void> {
    const stopped = await Promise.allSettled([this.lab.stop(), this.h.stop(), this.fleet.stop()]);
    const failed = stopped.find((result) => result.status === "rejected");
    if (failed !== undefined) throw new Error(`cleanup failed: ${String(failed.reason)}`);
  }
}
