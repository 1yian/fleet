import type { DatabaseSync } from "node:sqlite";
import { routed } from "@fleet/protocol/route";
import { runOnTransport } from "@fleet/protocol/transport";
import { routeFor } from "./merged-report.ts";
import type { Hosts } from "./pulls.ts";
import { loseGoneWrapper, silentWrappers, type LostJob, type SilentWrapper } from "./jobs.ts";
import { transaction } from "./store.ts";

const PROBE_TIMEOUT_MS = 10_000;
const ABSENT = "fleet-probe absent";

const SCRIPT = `LC_ALL=C
export LC_ALL
pid=$1
token=$2
err=$(kill -0 "$pid" 2>&1)
case "$?:$err" in
  0:*) ;;
  *"Operation not permitted"*) ;;
  *"No such process"*) echo "fleet-probe absent"; exit 0 ;;
  *) echo "fleet-probe unknown"; exit 0 ;;
esac
args=$(ps -ww -p "$pid" -o args= 2>/dev/null | sed 's/^[[:space:]]*//')
case "$args" in
  "" | "["*) echo "fleet-probe unknown" ;;
  *"$token"*) echo "fleet-probe alive" ;;
  *) echo "fleet-probe absent" ;;
esac`;

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
    const [file = "sh", ...args] = routed(route, ["sh", "-c", SCRIPT, "probe", String(pid), token]);
    runOnTransport(file, args, { timeout: PROBE_TIMEOUT_MS }, (error, stdout) => {
      resolve(error === null && stdout.trim() === ABSENT);
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
