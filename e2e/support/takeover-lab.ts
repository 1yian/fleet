import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { spawnGuarded } from "./guarded.ts";
import { SocksSsh } from "./socks-ssh.ts";
import { tempDir } from "./run-root.ts";

const TAKEOVER = fileURLToPath(
  new URL("../../packages/extension/src/takeover.ts", import.meta.url),
);
const WAIT_MS = 30_000;

export class FleetChrome {
  readonly ssh: SocksSsh;
  readonly home: string;
  readonly exited: Promise<number | null>;
  private readonly child: ChildProcess;
  private said = "";
  private browser: Browser | undefined;

  private constructor(args: readonly string[], ssh: SocksSsh, home: string) {
    this.ssh = ssh;
    this.home = home;
    this.child = spawnGuarded("node", [TAKEOVER, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        PATH: ssh.path,
        FLEET_CHROME_HOME: home,
        FLEET_CHROME_BIN: chromium.executablePath(),
        FLEET_CHROME_ARGS: "--headless=new --no-sandbox",
      },
    });
    for (const stream of [this.child.stdout, this.child.stderr])
      stream?.setEncoding("utf8").on("data", (chunk: string) => (this.said += chunk));
    this.exited = new Promise((resolve) => this.child.once("exit", resolve));
  }

  static start(
    args: readonly string[],
    ssh = new SocksSsh(),
    home = tempDir("fleet-chrome-"),
  ): FleetChrome {
    return new FleetChrome(args, ssh, home);
  }

  get output(): string {
    return this.said;
  }

  get pid(): number {
    assert.ok(this.child.pid !== undefined, "the takeover did not start");
    return this.child.pid;
  }

  async waitFor(pattern: RegExp): Promise<RegExpExecArray> {
    const deadline = Date.now() + WAIT_MS;
    for (;;) {
      const found = pattern.exec(this.said);
      if (found !== null) return found;
      assert.ok(
        Date.now() < deadline,
        `timed out waiting for ${String(pattern)} in:\n${this.said}`,
      );
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  send(line: string): void {
    this.child.stdin?.write(`${line}\n`);
  }

  endInput(): void {
    this.child.stdin?.end();
  }

  terminate(): void {
    this.child.kill("SIGTERM");
  }

  ctrlC(): void {
    process.kill(-this.pid, "SIGINT");
  }

  async macPage(): Promise<Page> {
    const port = (await this.waitFor(/Chrome debugging port: (\d+)/))[1];
    this.browser ??= await chromium.connectOverCDP(`http://127.0.0.1:${String(port)}`);
    const page = this.browser.contexts()[0]?.pages()[0];
    assert.ok(page !== undefined, "the Mac Chrome has no page");
    return page;
  }

  async letGo(): Promise<void> {
    await this.browser?.close().catch(() => undefined);
    this.browser = undefined;
  }

  async stop(): Promise<void> {
    await this.letGo();
    this.terminate();
    await this.exited;
  }
}
