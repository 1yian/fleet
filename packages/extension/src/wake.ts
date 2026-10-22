import { check, HttpOutcomeSchema, OPS, type OpArgs, type OpName } from "@fleet/protocol";
import { readLaneConfig } from "./lane-config.ts";

async function callAsLane<O extends OpName>(
  home: string,
  op: O,
  args: OpArgs<O>,
): Promise<unknown> {
  const lane = readLaneConfig(home);
  if (lane === undefined) throw new Error(`${home} is not a lane home`);
  const url = lane.url.replace(/^ws/, "http").replace(/\/session$/, "/call");
  const response = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${lane.token}`, "content-type": "application/json" },
    body: JSON.stringify({ op, args: check(OPS[op].args, args) }),
  });
  const outcome = check(HttpOutcomeSchema, await response.json());
  if (!outcome.ok) throw new Error(outcome.error);
  return outcome.value;
}

export async function wakeMate(home: string, args: OpArgs<"wake">): Promise<number> {
  return check(OPS.wake.result, await callAsLane(home, "wake", args)).entry;
}

export async function pauseFleet(home: string, reason: string | undefined): Promise<string> {
  const paused = check(
    OPS["fleet.pause"].result,
    await callAsLane(home, "fleet.pause", reason === undefined ? {} : { reason }),
  );
  const why = paused.reason === "" ? "" : `: ${paused.reason}`;
  return `fleet: paused since ${new Date(paused.since).toISOString()} by ${paused.by}${why}. No new worker starts and no wake is sent until fleet resume.`;
}

export async function resumeFleet(home: string): Promise<string> {
  const { resumed } = check(OPS["fleet.resume"].result, await callAsLane(home, "fleet.resume", {}));
  return resumed ? "fleet: resumed" : "fleet: was not paused";
}
