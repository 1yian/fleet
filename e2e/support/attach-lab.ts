import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { until } from "./guard-lab.ts";
import { isRecord, optionalString } from "./json.ts";
import { tempDir } from "./run-root.ts";

const FAKE_XPRA = fileURLToPath(new URL("./fake-xpra.ts", import.meta.url));
const FAKE_SSH = fileURLToPath(new URL("./fake-attach-ssh.ts", import.meta.url));

export interface Step {
  readonly exit?: number;
  readonly stay?: boolean;
  readonly say?: string;
}

export interface Run {
  readonly child: ChildProcess;
  readonly output: () => string;
  readonly exit: Promise<number | null>;
}

const lines = (file: string): unknown[] =>
  existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line): unknown => JSON.parse(line))
    : [];

export class AttachLab {
  readonly dir = tempDir("attach-lab-");
  readonly xpra: string;
  readonly ssh: string;
  private readonly running: ChildProcess[] = [];

  private readonly repo: string;

  constructor(repo: string) {
    this.repo = repo;
    this.xpra = join(this.dir, "xpra");
    this.ssh = join(this.dir, "ssh");
    writeFileSync(
      this.xpra,
      `#!/bin/sh\nexec '${process.execPath}' '${FAKE_XPRA}' '${this.dir}' "$@"\n`,
    );
    writeFileSync(
      this.ssh,
      `#!/bin/sh\nexec '${process.execPath}' '${FAKE_SSH}' '${this.dir}' "$@"\n`,
    );
    chmodSync(this.xpra, 0o755);
    chmodSync(this.ssh, 0o755);
  }

  plan(steps: readonly Step[]): void {
    writeFileSync(join(this.dir, "plan.json"), JSON.stringify(steps));
  }

  xpraArguments(): string[][] {
    return lines(join(this.dir, "calls.jsonl")).map((call) => {
      const argv = isRecord(call) ? call["argv"] : undefined;
      return Array.isArray(argv) ? argv.map(String) : [];
    });
  }

  hostsAsked(): string[] {
    return lines(join(this.dir, "ssh.jsonl")).map((call) =>
      isRecord(call) ? (optionalString(call, "host") ?? "") : "",
    );
  }

  xpraWasStopped(): boolean {
    return existsSync(join(this.dir, "terminated"));
  }

  attach(args: readonly string[]): Run {
    return this.start(join(this.repo, "bin", "fleet-attach"), [
      ...args,
      "--xpra",
      this.xpra,
      "--ssh",
      this.ssh,
      "--retry-ms",
      "20",
    ]);
  }

  hostXpra(args: readonly string[], runtime: string): Run {
    return this.start(
      join(this.repo, "bin", "fleet-chrome"),
      ["xpra", ...args, "--xpra", this.xpra, "--poll-ms", "100"],
      { XDG_RUNTIME_DIR: runtime },
    );
  }

  async waitForXpraStarts(count: number): Promise<void> {
    await until(
      () => (this.xpraArguments().length >= count ? true : undefined),
      `${String(count)} Xpra starts`,
    );
  }

  async waitForHostAsks(count: number): Promise<void> {
    await until(
      () => (this.hostsAsked().length >= count ? true : undefined),
      `${String(count)} guard checks`,
    );
  }

  private start(command: string, args: readonly string[], env: Record<string, string> = {}): Run {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    this.running.push(child);
    let text = "";
    child.stdout.on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
    });
    const exit = new Promise<number | null>((resolve) => {
      child.once("close", (code) => {
        resolve(code);
      });
    });
    return { child, output: () => text, exit };
  }

  stop(): void {
    for (const child of this.running) child.kill("SIGKILL");
  }
}
