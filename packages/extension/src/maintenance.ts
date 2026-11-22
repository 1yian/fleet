import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { maintenanceLine, type Maintenance } from "@fleet/protocol";
import { spawnDetached } from "./detached.ts";
import { FIRST_PASS_ARG } from "./first-pass.ts";
import { mateRelaunchArgs, readLaneConfig } from "./lane-config.ts";
import type { Link } from "./link.ts";
import { PROCESS_ARG } from "./process-id.ts";
import { LEAVING } from "./worker.ts";
import type { ReloadReceipt } from "./reload-observer.ts";

const RELAUNCH = fileURLToPath(new URL("./relaunch.ts", import.meta.url));

export const STALE_RELOAD_FLAG = "fleet-stale-reload";
const STALE_RELOAD_ARG = `--${STALE_RELOAD_FLAG}=`;
const STALE_RELOAD_GAP_MS = 10 * 60_000;

export const ownPane = (): string | undefined => {
  const pane = process.env["HERDR_PANE_ID"];
  return pane === undefined || pane === "" ? undefined : pane;
};

function lastStaleReload(pi: ExtensionAPI): number {
  const at = Number(pi.getFlag(STALE_RELOAD_FLAG));
  return Number.isFinite(at) ? at : 0;
}

export function relaunchSelf(
  ctx: ExtensionContext,
  pane: string,
  staleAt?: number,
  report?: ReloadReceipt,
  firstPass?: readonly string[],
): void {
  const running = process.argv
    .slice(2)
    .filter(
      (arg) =>
        arg !== "-c" &&
        arg !== "--continue" &&
        !arg.startsWith(STALE_RELOAD_ARG) &&
        !arg.startsWith(FIRST_PASS_ARG) &&
        !arg.startsWith(PROCESS_ARG),
    );
  const lane = readLaneConfig(process.cwd());
  const kept = lane === undefined ? running : mateRelaunchArgs(running, lane);
  const stale = staleAt === undefined ? kept : [...kept, `${STALE_RELOAD_ARG}${String(staleAt)}`];
  const args =
    firstPass === undefined ? stale : [...stale, `${FIRST_PASS_ARG}${firstPass.join(",")}`];
  const direnv = lane?.direnv;
  const helper = spawnDetached(
    process.execPath,
    [RELAUNCH, String(process.pid), pane, process.cwd(), ...args],
    {
      stdio: "ignore",
      env: {
        ...process.env,
        FLEET_RELAUNCH_DIRENV: direnv ?? "",
        FLEET_RELAUNCH_REPORT: report === undefined ? "" : JSON.stringify(report),
        FLEET_RELAUNCH_STARTED_AT: String(Math.trunc(Date.now() - process.uptime() * 1000)),
      },
    },
  );
  helper.unref();
  ctx.shutdown();
}

export class MaintenanceQueue {
  private readonly requests = new Map<number, Maintenance>();
  private busy = false;
  private readonly pi: ExtensionAPI;
  private readonly link: Link;
  private readonly ctx: ExtensionContext;
  private readonly mayHaveJobs: boolean;
  private readonly stow: (() => Promise<unknown>) | undefined;
  private readonly lastStaleReload: number;
  private readonly cardd: { readonly url: string; readonly token: string };
  private stalePane: string | undefined;

  constructor(
    pi: ExtensionAPI,
    link: Link,
    ctx: ExtensionContext,
    mayHaveJobs: boolean,
    stow: (() => Promise<unknown>) | undefined,
    cardd: { readonly url: string; readonly token: string },
  ) {
    this.pi = pi;
    this.link = link;
    this.ctx = ctx;
    this.mayHaveJobs = mayHaveJobs;
    this.stow = stow;
    this.cardd = cardd;
    this.lastStaleReload = lastStaleReload(pi);
    pi.on("agent_settled", () => {
      this.later();
    });
  }

  reloadForStaleCode(): boolean {
    const pane = ownPane();
    if (pane === undefined) return false;
    this.stalePane = pane;
    const wait = Math.max(0, this.lastStaleReload + STALE_RELOAD_GAP_MS - Date.now());
    setTimeout(() => {
      this.later();
    }, wait).unref();
    return true;
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

  private relaunchForStaleCode(pane: string): void {
    this.stalePane = undefined;
    this.pi.events.emit(LEAVING, {});
    relaunchSelf(this.ctx, pane, Date.now());
  }

  private async perform(): Promise<void> {
    const request = this.requests.values().next().value;
    if (this.busy || !this.safe()) return;
    if (this.stalePane !== undefined) {
      if (Date.now() >= this.lastStaleReload + STALE_RELOAD_GAP_MS)
        this.relaunchForStaleCode(this.stalePane);
      return;
    }
    if (request === undefined) return;
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
      this.pi.events.emit(LEAVING, {});
      relaunchSelf(this.ctx, pane, undefined, { ...this.cardd, id: request.id });
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
    [
      kind === "reload"
        ? `Waiting for a safe point, not yet ${done}`
        : `Waiting for a safe point, not yet ${done} (main hears when each finishes)`,
      "open",
    ],
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

export interface ReloadScope {
  readonly hosts: readonly string[];
}

const enroll = (link: Link, batch: string, scope: ReloadScope | undefined) =>
  scope === undefined
    ? link.call("maintenance.request", { batch, kind: "reload" })
    : link.call("maintenance.scoped", { batch, hosts: [...scope.hosts] });

const CARDD_WITHOUT_SCOPE =
  "cardd answered that it has no scoped reload enrollment, so nothing was enrolled: update cardd first";

const UNCONFIRMED_SCOPE =
  "scoped reload enrollment could not be confirmed, so some sessions on the selected hosts may or may not have been enrolled: a cardd from before scoped enrollment drops the connection instead of answering, so update cardd first if it is old";

const refusedScope = (error: unknown): boolean =>
  String(error).includes("unknown operation maintenance.scoped");

export async function requestAndAwait(
  link: Link,
  scope: ReloadScope | undefined,
  batch: string,
  waitMs: number,
): Promise<Maintenance[]> {
  const deadline = Date.now() + waitMs;
  const open = (rows: readonly Maintenance[]): boolean =>
    rows.some((row) => row.state === "pending" || row.state === "reloading");
  const first = async (): Promise<Maintenance[]> => {
    for (;;) {
      try {
        return await enroll(link, batch, scope);
      } catch (error) {
        if (scope !== undefined && refusedScope(error))
          throw new Error(CARDD_WITHOUT_SCOPE, { cause: error });
        if (Date.now() > deadline)
          throw scope === undefined
            ? error
            : new Error(
                `${UNCONFIRMED_SCOPE} (${error instanceof Error ? error.message : String(error)})`,
                {
                  cause: error,
                },
              );
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      }
    }
  };
  let rows = await first();
  const enrolled = rows;
  while (open(rows) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    rows = await link.call("maintenance.status", { batch }).catch(() => rows);
  }
  if (rows.some((row) => row.state === "reloading"))
    rows = await link.call("maintenance.status", { batch, failUnverified: true });
  const kept = enrolled
    .filter((row) => !rows.some((each) => each.id === row.id))
    .map((row): Maintenance =>
      row.state === "pending" || row.state === "reloading"
        ? {
            ...row,
            state: "failed",
            detail: "no longer reported (its lane was removed), so it is not verified",
          }
        : row,
    );
  return [...rows, ...kept].sort((a, b) => a.id - b.id);
}
