import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, openSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LaneName } from "../shared/lane-name.js";
import type { Control, Handoff, LaneSnapshot, LaneStatusName, TabInfo } from "../shared/protocol.js";
import { CdpClient } from "./cdp.js";
import { assertPinnedChrome, chromeArgs } from "./chrome.js";
import type { Config } from "./config.js";
import { HttpError } from "./errors.js";
import type { LaneSlot } from "./registry.js";

const CRASH_WINDOW_MS = 5 * 60 * 1000;
const MAX_CRASHES = 5;
const SINGLETON_FILES = ["SingletonLock", "SingletonSocket", "SingletonCookie"];

interface JsonVersion {
  Browser: string;
  webSocketDebuggerUrl: string;
}

interface JsonTarget {
  id: string;
  type: string;
  title: string;
  url: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class Lane extends EventEmitter {
  readonly name: LaneName;
  readonly slot: LaneSlot;
  readonly dir: string;
  status: LaneStatusName = "stopped";
  error: string | null = null;
  control: Control = { kind: "agent" };
  handoff: Handoff | null = null;
  activeTarget: string | undefined;
  private secretFlowActive = false;

  private readonly config: Config;
  private chrome: ChildProcess | null = null;
  private xvfb: ChildProcess | null = null;
  private chromeVersion: string | undefined;
  private wanted = false;
  private starting: Promise<void> | null = null;
  private crashes: number[] = [];
  private restartTimer: NodeJS.Timeout | null = null;
  private readonly waiters = new Map<string, Array<(handoff: Handoff) => void>>();
  private expiryTimer: NodeJS.Timeout | null = null;
  private readonly releaseTimers = new Map<string, NodeJS.Timeout>();
  readonly streams = new Map<string, { dispose(): void }>();

  constructor(name: LaneName, slot: LaneSlot, config: Config) {
    super();
    this.name = name;
    this.slot = slot;
    this.config = config;
    this.dir = join(config.dataDir, "lanes", name);
    this.setMaxListeners(100);
    this.on("activate", (targetId: string) => {
      this.activeTarget = targetId;
    });
  }

  get profileDir(): string {
    return join(this.dir, "profile");
  }

  get screenWidth(): number {
    return this.config.lanes.screen.width;
  }

  get screenHeight(): number {
    return this.config.lanes.screen.height;
  }

  get displayName(): string {
    return `:${this.slot.display}`;
  }

  start(): Promise<void> {
    this.wanted = true;
    if (this.status === "ready" && this.chrome && this.chrome.exitCode === null) return Promise.resolve();
    this.starting ??= this.launch().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  async stop(): Promise<void> {
    this.wanted = false;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    await this.starting?.catch(() => undefined);
    await this.shutdownProcesses();
    this.setStatus("stopped");
  }

  async restart(): Promise<void> {
    this.crashes = [];
    await this.stop();
    await this.start();
  }

  async browserWsUrl(): Promise<string> {
    const version = await this.jsonVersion();
    return version.webSocketDebuggerUrl;
  }

  async tabs(): Promise<TabInfo[]> {
    if (this.status !== "ready") return [];
    const response = await fetch(`http://127.0.0.1:${this.slot.cdpPort}/json/list`);
    const targets = (await response.json()) as JsonTarget[];
    return targets.filter((t) => t.type === "page").map((t) => ({ id: t.id, title: t.title, url: t.url }));
  }

  async snapshot(): Promise<LaneSnapshot> {
    let tabs: TabInfo[] = [];
    try {
      tabs = await this.tabs();
    } catch {
      tabs = [];
    }
    return {
      lane: this.name,
      status: this.status,
      error: this.error,
      chromeVersion: this.chromeVersion,
      chromePid: this.chrome?.pid,
      display: this.displayName,
      tabs,
      control: this.control,
      handoff: this.handoff,
      credentialStep: this.secretFlowActive,
      viewLink: this.config.handoff.linkTemplate?.replaceAll("{lane}", this.name) ?? null,
    };
  }

  get tainted(): boolean {
    return this.secretFlowActive;
  }

  beginSecretFlow(): () => void {
    if (this.secretFlowActive)
      throw new HttpError(409, "another credential step is already running on this lane");
    const lock = this.agentLock();
    if (lock) throw new HttpError(409, `lane ${this.name} is ${lock}`);
    this.secretFlowActive = true;
    this.emit("change");
    return () => {
      this.secretFlowActive = false;
      this.emit("change");
    };
  }

  agentLock(): string | null {
    if (this.handoff?.status === "open") return `waiting for the captain (${this.handoff.reason})`;
    if (this.control.kind === "human") return "under the captain's control from the board";
    return null;
  }

  takeControl(viewerId: string, force = false): boolean {
    if (this.control.kind === "human" && this.control.viewerId !== viewerId && !force) return false;
    this.control = { kind: "human", viewerId, since: Date.now() };
    this.emit("change");
    return true;
  }

  viewerGone(viewerId: string, graceMs: number): void {
    this.viewerBack(viewerId);
    this.releaseTimers.set(
      viewerId,
      setTimeout(() => {
        this.releaseTimers.delete(viewerId);
        this.releaseControl(viewerId);
      }, graceMs),
    );
  }

  viewerBack(viewerId: string): void {
    const timer = this.releaseTimers.get(viewerId);
    if (timer) clearTimeout(timer);
    this.releaseTimers.delete(viewerId);
  }

  releaseControl(viewerId: string): void {
    if (this.control.kind === "human" && this.control.viewerId === viewerId) {
      this.control = { kind: "agent" };
      this.emit("change");
    }
  }

  openHandoff(reason: string, waitSeconds: number): Handoff {
    if (this.handoff?.status === "open") return this.handoff;
    const now = Date.now();
    this.handoff = {
      id: randomBytes(6).toString("hex"),
      lane: this.name,
      reason,
      createdAt: now,
      expiresAt: now + waitSeconds * 1000,
      status: "open",
    };
    this.expiryTimer = setTimeout(
      () => this.resolveHandoff(this.handoff?.id ?? "", "expired"),
      waitSeconds * 1000,
    );
    this.emit("handoff", this.handoff);
    this.emit("change");
    return this.handoff;
  }

  resolveHandoff(id: string, status: "done" | "cancelled" | "expired"): Handoff | null {
    const handoff = this.handoff;
    if (!handoff || handoff.id !== id || handoff.status !== "open")
      return handoff?.id === id ? handoff : null;
    handoff.status = status;
    handoff.resolvedAt = Date.now();
    this.emit("handoff", handoff);
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    if (this.control.kind === "human") this.control = { kind: "agent" };
    for (const resolve of this.waiters.get(id) ?? []) resolve(handoff);
    this.waiters.delete(id);
    this.emit("change");
    return handoff;
  }

  waitHandoff(id: string, timeoutMs: number): Promise<Handoff | null> {
    const handoff = this.handoff;
    if (!handoff || handoff.id !== id) return Promise.resolve(null);
    if (handoff.status !== "open") return Promise.resolve(handoff);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(this.handoff?.id === id ? this.handoff : null), timeoutMs);
      const list = this.waiters.get(id) ?? [];
      list.push((resolved) => {
        clearTimeout(timer);
        resolve(resolved);
      });
      this.waiters.set(id, list);
    });
  }

  private setStatus(status: LaneStatusName, error?: string): void {
    this.status = status;
    this.error = error ?? null;
    this.emit("change");
  }

  private async jsonVersion(): Promise<JsonVersion> {
    const response = await fetch(`http://127.0.0.1:${this.slot.cdpPort}/json/version`);
    return (await response.json()) as JsonVersion;
  }

  private async launch(): Promise<void> {
    this.setStatus("starting");
    try {
      this.chromeVersion = await assertPinnedChrome(this.config);
      for (const sub of ["profile", "home", "downloads"])
        mkdirSync(join(this.dir, sub), { recursive: true, mode: 0o700 });
      for (const file of SINGLETON_FILES) rmSync(join(this.profileDir, file), { force: true });
      await this.startXvfb();
      await this.startChrome();
      this.setStatus("ready");
    } catch (error) {
      await this.shutdownProcesses();
      this.setStatus("failed", error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  private async startXvfb(): Promise<void> {
    const auth = join(this.dir, "Xauthority");
    writeFileSync(auth, "", { mode: 0o600 });
    await new Promise<void>((resolve, reject) => {
      execFile(
        "xauth",
        ["-f", auth, "add", this.displayName, ".", randomBytes(16).toString("hex")],
        (error) => (error ? reject(error) : resolve()),
      );
    });
    const log = openSync(join(this.dir, "xvfb.log"), "a", 0o600);
    const { width, height } = this.config.lanes.screen;
    const socket = `/tmp/.X11-unix/X${this.slot.display}`;
    rmSync(socket, { force: true });
    const xvfb = spawn(
      "Xvfb",
      [
        this.displayName,
        "-screen",
        "0",
        `${width}x${height}x24`,
        "-nolisten",
        "tcp",
        "-auth",
        auth,
        "-noreset",
      ],
      {
        stdio: ["ignore", log, log],
      },
    );
    this.xvfb = xvfb;
    xvfb.once("exit", () => {
      if (this.xvfb === xvfb) this.xvfb = null;
    });
    for (let i = 0; i < 100; i += 1) {
      if (existsSync(socket)) return;
      if (xvfb.exitCode !== null)
        throw new Error(`Xvfb exited with ${xvfb.exitCode}; see ${join(this.dir, "xvfb.log")}`);
      await sleep(50);
    }
    throw new Error("Xvfb did not create its display socket");
  }

  private async startChrome(): Promise<void> {
    const log = openSync(join(this.dir, "chrome.log"), "a", 0o600);
    const args = chromeArgs({
      profileDir: this.profileDir,
      port: this.slot.cdpPort,
      screen: this.config.lanes.screen,
    });
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: join(this.dir, "home"),
      XDG_CONFIG_HOME: join(this.dir, "home", ".config"),
      XDG_CACHE_HOME: join(this.dir, "home", ".cache"),
      DISPLAY: this.displayName,
      XAUTHORITY: join(this.dir, "Xauthority"),
      LANG: "en_US.UTF-8",
    };
    const chrome = spawn("taskset", ["-c", this.slot.cpuList, this.config.chrome.path, ...args], {
      stdio: ["ignore", log, log],
      env,
    });
    this.chrome = chrome;
    chrome.once("exit", (code, signal) => this.onChromeExit(chrome, code, signal));
    for (let i = 0; i < 200; i += 1) {
      if (chrome.exitCode !== null)
        throw new Error(`Chrome exited with ${chrome.exitCode}; see ${join(this.dir, "chrome.log")}`);
      try {
        await this.jsonVersion();
        return;
      } catch {
        await sleep(100);
      }
    }
    throw new Error("Chrome did not open its debugging port");
  }

  private onChromeExit(chrome: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.chrome !== chrome) return;
    this.chrome = null;
    if (!this.wanted) return;
    const now = Date.now();
    this.crashes = this.crashes.filter((t) => now - t < CRASH_WINDOW_MS);
    this.crashes.push(now);
    void this.shutdownProcesses().then(() => {
      if (this.crashes.length >= MAX_CRASHES) {
        this.setStatus(
          "failed",
          `Chrome crashed ${MAX_CRASHES} times in 5 minutes (last exit ${code ?? signal})`,
        );
        return;
      }
      this.setStatus("starting");
      const delay = Math.min(30_000, 1000 * 2 ** (this.crashes.length - 1));
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        this.starting = this.launch()
          .catch(() => undefined)
          .finally(() => {
            this.starting = null;
          });
      }, delay);
    });
  }

  private async shutdownProcesses(): Promise<void> {
    const chrome = this.chrome;
    this.chrome = null;
    if (chrome && chrome.exitCode === null) {
      await this.closeBrowserGracefully();
      await this.waitExit(chrome, 8000);
      if (chrome.exitCode === null) chrome.kill("SIGTERM");
      await this.waitExit(chrome, 4000);
      if (chrome.exitCode === null) chrome.kill("SIGKILL");
      await this.waitExit(chrome, 2000);
    }
    const xvfb = this.xvfb;
    this.xvfb = null;
    if (xvfb && xvfb.exitCode === null) {
      xvfb.kill("SIGTERM");
      await this.waitExit(xvfb, 3000);
      if (xvfb.exitCode === null) xvfb.kill("SIGKILL");
    }
  }

  private async closeBrowserGracefully(): Promise<void> {
    try {
      const cdp = await CdpClient.connect(await this.browserWsUrl());
      await Promise.race([cdp.send("Browser.close"), sleep(3000)]);
      cdp.close();
    } catch {
      return;
    }
  }

  private async waitExit(child: ChildProcess, ms: number): Promise<void> {
    if (child.exitCode !== null) return;
    await Promise.race([new Promise<void>((resolve) => child.once("exit", () => resolve())), sleep(ms)]);
  }
}
