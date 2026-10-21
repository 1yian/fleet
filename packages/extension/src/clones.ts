import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { check, OPS } from "@fleet/protocol";
import { HostUnreachable, NoTransport, onHost } from "./host.ts";
import type { Link } from "./link.ts";

export const SYNC_FUNCTIONS = readFileSync(
  fileURLToPath(new URL("./sync.sh", import.meta.url)),
  "utf8",
);

export interface Clone {
  readonly project: string;
  readonly host: string;
  readonly path: string;
  readonly base: string;
}

const SLOW_FETCH_TIMEOUT_MS = 120_000;

const NOTHING_CHANGED = /: (already current|skipped: no origin remote)$/;

const NEEDS_THE_CAPTAIN = ": STUCK: ";

export async function refreshClonesInTurn(clones: readonly Clone[]): Promise<string[]> {
  const lines: string[] = [];
  for (const { project, host, path, base } of clones) {
    const label = `${project} on ${host}`;
    const script = `${SYNC_FUNCTIONS}\nrefresh_clone "$@"`;
    try {
      const argv = ["sh", "-c", script, "refresh", path, base, label];
      const out = await onHost(host, argv, SLOW_FETCH_TIMEOUT_MS);
      lines.push(...out.split("\n").filter((line) => line !== ""));
    } catch (error) {
      if (error instanceof NoTransport) {
        lines.push(`${label}: skipped: ${error.message}`);
        continue;
      }
      const why = error instanceof HostUnreachable ? "cannot be reached" : "refresh failed";
      lines.push(`${label}: ${why}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return lines.filter((line) => !NOTHING_CHANGED.test(line));
}

export function refreshEveryCloneOnFirstConnect(pi: ExtensionAPI, link: Link): void {
  let started = false;
  pi.events.on("fleet:connected", () => {
    if (started) return;
    started = true;
    void (async () => {
      const projects = check(OPS.projects.result, await link.call("projects", {}));
      const clones = projects
        .filter(({ delivery }) => delivery !== "local-only")
        .flatMap(({ name, base, clones: each }) =>
          each.map(({ host, path }) => ({ project: name, host, path, base })),
        );
      const lines = await refreshClonesInTurn(clones);
      if (lines.length === 0) return;
      const urgent = lines.some((line) => line.includes(NEEDS_THE_CAPTAIN));
      pi.sendMessage(
        {
          customType: "fleet-clones",
          content: `[fleet] clones: ${lines.join("; ")}`,
          display: true,
        },
        urgent ? { triggerTurn: true, deliverAs: "followUp" } : { triggerTurn: false },
      );
    })().catch((error: unknown) => {
      console.error(`clone refresh: ${String(error)}`);
    });
  });
}
