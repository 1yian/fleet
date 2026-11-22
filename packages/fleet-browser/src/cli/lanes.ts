import { spawn } from "node:child_process";
import type { Handoff, LaneSnapshot } from "../shared/protocol.js";

export function ringHerdr(title: string, body: string): void {
  const herdr = process.env.HERDR_BIN_PATH ?? (process.env.HERDR_ENV ? "herdr" : null);
  if (!herdr) return;
  const child = spawn(herdr, ["notification", "show", title, "--body", body, "--sound", "request"], {
    stdio: "ignore",
  });
  child.once("error", () => undefined);
}

function link(text: string, url: string | null): string {
  return url ? `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\` : text;
}

export function renderLanes(lanes: LaneSnapshot[], plain = false): string {
  if (lanes.length === 0) return "no lanes yet";
  return lanes
    .map((lane) => {
      const handoff = lane.handoff?.status === "open" ? `  HANDOFF: ${lane.handoff.reason}` : "";
      const control = lane.control.kind === "human" ? "  captain driving" : "";
      const page = lane.tabs[0]?.url ?? "";
      return `${plain ? lane.lane.padEnd(14) : link(lane.lane.padEnd(14), lane.viewLink)} ${lane.status.padEnd(9)}${page.slice(0, 60)}${control}${handoff}`;
    })
    .join("\n");
}

async function fetchLanes(): Promise<LaneSnapshot[]> {
  const response = await fetch(`${process.env.FLEET_BROWSER_URL ?? "http://127.0.0.1:7620"}/v1/lanes`);
  return (await response.json()) as LaneSnapshot[];
}

export async function watchLanes(notify: boolean): Promise<void> {
  const announced = new Set<string>();
  for (;;) {
    let text: string;
    try {
      const lanes = await fetchLanes();
      text = renderLanes(lanes);
      for (const lane of lanes) {
        const handoff: Handoff | null = lane.handoff;
        if (notify && handoff?.status === "open" && !announced.has(handoff.id)) {
          announced.add(handoff.id);
          ringHerdr(`Browser needs you: ${lane.lane}`, handoff.reason);
        }
      }
    } catch {
      text = "the fleet-browser service is not reachable";
    }
    process.stdout.write(`\x1b[2J\x1b[Hbrowser lanes\n\n${text}\n`);
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

export const listLanes = fetchLanes;
