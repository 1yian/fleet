import type { DatabaseSync } from "node:sqlite";
import { routed } from "@fleet/protocol/route";
import { runOnTransport } from "@fleet/protocol/transport";
import { routeFor } from "./merged-report.ts";
import type { Hosts } from "./pulls.ts";
import { loseGoneWrapper, silentWrappers, type LostJob, type SilentWrapper } from "./jobs.ts";
import { transaction } from "./store.ts";

const PROBE_TIMEOUT_MS = 10_000;
const NO_SUCH_PROCESS = 1;

type Presence = "present" | "absent" | "unknown";

function probeWrapper(hosts: Hosts, { host, pid }: SilentWrapper): Promise<Presence> {
  return new Promise((resolve) => {
    let route: readonly string[];
    try {
      route = routeFor(hosts, host);
    } catch {
      resolve("unknown");
      return;
    }
    const [file = "ps", ...args] = routed(route, ["ps", "-p", String(pid), "-o", "pid="]);
    runOnTransport(file, args, { timeout: PROBE_TIMEOUT_MS }, (error, stdout, stderr) => {
      if (error === null) resolve(stdout.trim() === String(pid) ? "present" : "unknown");
      else if (error.code === NO_SUCH_PROCESS && stdout.trim() === "" && stderr.trim() === "")
        resolve("absent");
      else resolve("unknown");
    });
  });
}

export async function loseGoneJobs(
  db: DatabaseSync,
  hosts: Hosts,
  before: number,
  lose: (lost: readonly LostJob[]) => string[],
): Promise<string[]> {
  const silent = silentWrappers(db, before);
  const probed = await Promise.all(
    silent.map(async (wrapper) => ({ wrapper, presence: await probeWrapper(hosts, wrapper) })),
  );
  const confirmed = probed.filter(({ presence }) => presence === "absent");
  return transaction(db, () =>
    confirmed.flatMap(({ wrapper }) => lose(loseGoneWrapper(db, wrapper))),
  );
}
