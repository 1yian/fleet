import type { DatabaseSync } from "node:sqlite";
import { routed } from "@fleet/protocol/route";
import { runOnTransport } from "@fleet/protocol/transport";
import { routeFor } from "./merged-report.ts";
import type { Hosts } from "./pulls.ts";
import { loseGoneWrapper, silentWrappers, type LostJob, type SilentWrapper } from "./jobs.ts";
import { transaction } from "./store.ts";

const PROBE_TIMEOUT_MS = 10_000;
const NO_SUCH_PROCESS = 1;

const SCRIPT = `[ "$(ps -p $$ -o pid= 2>/dev/null | tr -d ' ')" = "$$" ] || exit 3
exec ps -ww -p "$1" -o args= 2>/dev/null`;

function wrapperIsGone(hosts: Hosts, { job, host, pid, launch }: SilentWrapper): Promise<boolean> {
  return new Promise((resolve) => {
    let route: readonly string[];
    try {
      route = routeFor(hosts, host);
    } catch {
      resolve(false);
      return;
    }
    const token = `fleet-job-${String(job)}-${launch}.json`;
    const [file = "sh", ...args] = routed(route, ["sh", "-c", SCRIPT, "probe", String(pid)]);
    runOnTransport(file, args, { timeout: PROBE_TIMEOUT_MS }, (error, stdout, stderr) => {
      const argv = stdout.trim();
      if (error === null) resolve(argv !== "" && !argv.includes(token));
      else resolve(error.code === NO_SUCH_PROCESS && argv === "" && stderr.trim() === "");
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
    silent.map(async (wrapper) => ({ wrapper, gone: await wrapperIsGone(hosts, wrapper) })),
  );
  const confirmed = probed.filter(({ gone }) => gone);
  return transaction(db, () =>
    confirmed.flatMap(({ wrapper }) => lose(loseGoneWrapper(db, wrapper))),
  );
}
