import { check, OPS } from "@fleet/protocol";
import type { Session } from "./cardd.ts";
import { confirmGone } from "./fleet.ts";

export async function startLostJob(worker: Session, label: string): Promise<number> {
  const { job } = check(
    OPS["job.start"].result,
    await worker.call("job.start", { label, command: "sleep 9" }),
  );
  await confirmGone(worker, job);
  return job;
}
