import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { maintenanceLine, type Maintenance } from "@fleet/protocol";
import { mateRelaunchArgs, readLaneConfig } from "./lane-config.ts";
import type { Link } from "./link.ts";

const RELAUNCH = fileURLToPath(new URL("./relaunch.ts", import.meta.url));

export const ownPane = (): string | undefined => {
  const pane = process.env["HERDR_PANE_ID"];
  return pane === undefined || pane === "" ? undefined : pane;
};

export function relaunchSelf(ctx: ExtensionContext, pane: string): void {
  const running = process.argv.slice(2).filter((arg) => arg !== "-c" && arg !== "--continue");
  const lane = readLaneConfig(process.cwd());
  const args = lane === undefined ? running : mateRelaunchArgs(running, lane);
  const direnv = lane?.direnv;
  const helper = spawn(
    process.execPath,
    [RELAUNCH, String(process.pid), pane, process.cwd(), ...args],
    {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, FLEET_RELAUNCH_DIRENV: direnv ?? "" },
    },
  );
  helper.unref();
  ctx.shutdown();
}

export class MaintenanceQueue {
  private readonly requests = new Map<number, Maintenance>();
  private busy = false;
  private readonly link: Link;
  private readonly ctx: ExtensionContext;
  private readonly mayHaveJobs: boolean;
  private readonly stow: (() => Promise<unknown>) | undefined;

  constructor(
    pi: ExtensionAPI,
    link: Link,
    ctx: ExtensionContext,
    mayHaveJobs: boolean,
    stow: (() => Promise<unknown>) | undefined,
  ) {
    this.link = link;
    this.ctx = ctx;
    this.mayHaveJobs = mayHaveJobs;
    this.stow = stow;
    pi.on("agent_settled", () => {
      this.later();
    });
  }

  receive(request: Maintenance): void {
    this.requests.set(request.id, request);
    this.later();
  }

  private later(): void {
    setImmediate(() => {
      void this.perform().catch(() => undefined);
    });
  }

  private safe(): boolean {
    return this.ctx.isIdle() && !this.ctx.hasPendingMessages();
  }

  private async jobsRunning(): Promise<boolean> {
    return this.mayHaveJobs && (await this.link.call("jobs", {})).length > 0;
  }

  private async perform(): Promise<void> {
    const request = this.requests.values().next().value;
    if (this.busy || request === undefined || !this.safe()) return;
    this.busy = true;
    try {
      if (await this.jobsRunning()) return;
      await this.reload(request);
    } finally {
      this.busy = false;
    }
  }

  private async reload(request: Maintenance): Promise<void> {
    const ack = (state: "pending" | "reloading" | "failed", detail: string) =>
      this.link.call("maintenance.ack", { id: request.id, state, detail });
    try {
      const pane = ownPane();
      if (pane === undefined)
        throw new Error("it runs outside a herdr pane, so it was left running");
      if (request.kind === "stow") await this.runStow(request);
      if (!this.safe()) return;
      await ack("reloading", "safe point reached; waiting for it to reconnect on a new process");
      if (!this.safe()) {
        await ack(
          "pending",
          "a message arrived at the safe point, so the reload waits for the next",
        );
        return;
      }
      this.requests.delete(request.id);
      relaunchSelf(this.ctx, pane);
    } catch (error) {
      this.requests.delete(request.id);
      const detail = error instanceof Error ? error.message : String(error);
      await ack("failed", detail).catch(() => undefined);
    }
  }

  private async runStow(request: Maintenance): Promise<void> {
    if (this.stow === undefined) throw new Error("it has no memory to stow");
    await this.stow();
    this.requests.set(request.id, { ...request, kind: "reload" });
  }
}

const sections = (kind: Maintenance["kind"]) => {
  const done = kind === "stow" ? "stowed" : "reloaded";
  return [
    [kind === "stow" ? "Stowed and verified" : "Reloaded and verified", "completed"],
    [`Waiting for a safe point, not yet ${done} (main hears when each finishes)`, "open"],
    [`Unable to ${kind}`, "failed"],
  ] as const;
};

export function maintenanceReport(rows: readonly Maintenance[]): string[] {
  const [first] = rows;
  if (first === undefined)
    return ["No connected second mates or workers: stopped and held lanes were left as they are."];
  return sections(first.kind).flatMap(([title, state]) => {
    const found = rows.filter((row) =>
      state === "open" ? row.state === "pending" || row.state === "reloading" : row.state === state,
    );
    return found.length === 0
      ? []
      : [`${title}:`, ...found.map((row) => `- ${maintenanceLine(row)}`)];
  });
}

const POLL_MS = 500;

export async function requestAndAwait(
  link: Link,
  kind: Maintenance["kind"],
  batch: string,
  waitMs: number,
): Promise<Maintenance[]> {
  const deadline = Date.now() + waitMs;
  const open = (rows: readonly Maintenance[]): boolean =>
    rows.some((row) => row.state === "pending" || row.state === "reloading");
  const first = async (): Promise<Maintenance[]> => {
    for (;;) {
      try {
        return await link.call("maintenance.request", { batch, kind });
      } catch (error) {
        if (Date.now() > deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      }
    }
  };
  let rows = await first();
  while (open(rows) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    rows = await link.call("maintenance.status", { batch }).catch(() => rows);
  }
  return rows;
}
