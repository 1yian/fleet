import { request } from "node:http";
import { existsSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Link } from "./link.ts";

type Label = "ok" | "slow" | "refusing-new" | "down" | "unreachable";

interface Settings {
  readonly intervalMs: number;
  readonly deadlineMs: number;
  readonly failures: number;
  readonly downFailures: number;
  readonly controlPort: number;
}

const SQLITE_BUSY = 5;

function number(name: string, fallback: number): number {
  const set = Number(process.env[name]);
  return Number.isInteger(set) && set > 0 ? set : fallback;
}

const settings = (): Settings => ({
  intervalMs: number("FLEET_PROBE_INTERVAL_MS", 60_000),
  deadlineMs: number("FLEET_PROBE_DEADLINE_MS", 5_000),
  failures: number("FLEET_PROBE_FAILS", 3),
  downFailures: number("FLEET_PROBE_DOWN_FAILS", 5),
  controlPort: number("FLEET_PROBE_CONTROL_PORT", 22),
});

interface Fresh {
  readonly state: "accepted" | "refused" | "failed";
  readonly body: string;
}

function freshConnection(url: URL, deadlineMs: number): Promise<Fresh> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: Fresh): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      call.destroy();
      resolve(value);
    };
    const call = request(
      {
        host: url.hostname,
        port: url.port,
        path: "/api/version",
        agent: false,
        headers: { connection: "close" },
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (body += chunk));
        response.on("end", () => {
          finish({ state: "accepted", body });
        });
        response.on("error", () => {
          finish({ state: "accepted", body: "" });
        });
      },
    );
    const timer = setTimeout(() => {
      finish({ state: "failed", body: "" });
    }, deadlineMs);
    call.on("error", (error) => {
      finish({
        state: Reflect.get(error, "code") === "ECONNREFUSED" ? "refused" : "failed",
        body: "",
      });
    });
    call.end();
  });
}

async function existingSocket(link: Link, deadlineMs: number): Promise<number | undefined> {
  const started = Date.now();
  try {
    await link.call("lane.plan", {}, deadlineMs);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (/unreachable|closed the connection|did not answer in time/.test(message)) return undefined;
  }
  return Date.now() - started;
}

function controlPasses(host: string, port: number, deadlineMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const finish = (passes: boolean): void => {
      socket.destroy();
      resolve(passes);
    };
    socket.setTimeout(deadlineMs, () => {
      finish(false);
    });
    socket.on("connect", () => {
      finish(true);
    });
    socket.on("error", (error) => {
      finish(Reflect.get(error, "code") === "ECONNREFUSED");
    });
  });
}

function lifecycleHeld(home: string): boolean {
  const file = join(home, "state", "lifecycle.db");
  if (!existsSync(file)) return false;
  const db = new DatabaseSync(file, { timeout: 0 });
  try {
    db.exec("BEGIN IMMEDIATE");
    db.exec("ROLLBACK");
    return false;
  } catch (error) {
    return error instanceof Error && Reflect.get(error, "errcode") === SQLITE_BUSY;
  } finally {
    db.close();
  }
}

function commitOf(body: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const commit: unknown = Reflect.get(parsed, "commit");
    return typeof commit === "string" ? commit : undefined;
  } catch {
    return undefined;
  }
}

class Incident {
  private failing = 0;
  private allDown = true;
  private open = false;
  private readonly rules: Pick<Settings, "failures" | "downFailures">;

  constructor(rules: Pick<Settings, "failures" | "downFailures">) {
    this.rules = rules;
  }

  get count(): number {
    return this.failing;
  }

  quiet(): void {
    this.failing = 0;
    this.allDown = true;
    this.open = false;
  }

  record(label: Label): "alert" | "recovered" | undefined {
    if (label === "ok") {
      const wasOpen = this.open;
      this.quiet();
      return wasOpen ? "recovered" : undefined;
    }
    this.failing += 1;
    this.allDown = this.allDown && label === "down";
    const needed = this.allDown ? this.rules.downFailures : this.rules.failures;
    if (this.failing < needed || this.open) return undefined;
    this.open = true;
    return "alert";
  }
}

const ADVICE: Readonly<Record<Exclude<Label, "ok">, string>> = {
  slow: "cardd answers, but slowly",
  "refusing-new": "cardd is refusing new connections while existing sessions still work",
  down: "cardd refuses every connection",
  unreachable: "this host cannot reach cardd's machine at all",
};

function describe(label: Exclude<Label, "ok">, url: URL, count: number): string {
  return `[fleet] cardd probe: ${ADVICE[label]} (${label}; ${String(count)} failing probes in a row against ${url.host}). Tell the captain. Do not restart or kill cardd yourself: new workers and lanes may fail to connect until it recovers.`;
}

export function watchMainCardd(
  pi: ExtensionAPI,
  link: Link,
  where: { readonly url: string; readonly role: string; readonly lane: string | undefined },
  home: string,
): void {
  if (where.role === "mate" && where.lane === "main") watchCardd(pi, link, where.url, home);
}

function watchCardd(pi: ExtensionAPI, link: Link, url: string, home: string): void {
  const target = new URL(url.replace(/^ws/, "http"));
  const rules = settings();
  const incident = new Incident(rules);
  let lastCommit: string | undefined;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const tell = (content: string): void => {
    pi.sendMessage(
      { customType: "fleet-probe", content, display: true },
      { triggerTurn: true, deliverAs: "followUp" },
    );
  };

  const label = async (): Promise<Label> => {
    const [fresh, existing] = await Promise.all([
      freshConnection(target, rules.deadlineMs),
      existingSocket(link, rules.deadlineMs),
    ]);
    if (fresh.state === "accepted") {
      const commit = commitOf(fresh.body);
      const changed = lastCommit !== undefined && commit !== undefined && commit !== lastCommit;
      lastCommit = commit ?? lastCommit;
      if (changed) incident.quiet();
      return existing === undefined ? "slow" : "ok";
    }
    if (existing !== undefined) return "refusing-new";
    if (fresh.state === "refused") return "down";
    if (!(await controlPasses(target.hostname, rules.controlPort, rules.deadlineMs)))
      return "unreachable";
    return "down";
  };

  const probe = async (): Promise<void> => {
    if (lifecycleHeld(home)) {
      incident.quiet();
      return;
    }
    const found = await label();
    if (lifecycleHeld(home)) {
      incident.quiet();
      return;
    }
    const verdict = incident.record(found);
    if (verdict === "alert" && found !== "ok") tell(describe(found, target, incident.count));
    if (verdict === "recovered") tell(`[fleet] cardd probe: cardd answers again (${target.host}).`);
  };

  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      probe()
        .catch(() => undefined)
        .finally(schedule);
    }, rules.intervalMs);
    timer.unref();
  };

  pi.on("session_shutdown", () => {
    stopped = true;
    clearTimeout(timer);
  });
  schedule();
}
