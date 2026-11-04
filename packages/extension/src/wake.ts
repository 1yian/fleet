import { check, HttpOutcomeSchema, OPS, type OpArgs } from "@fleet/protocol";
import { readLaneConfig } from "./lane-config.ts";
import { bwsFor, laneToken } from "./lane-secrets.ts";

export async function wakeMate(home: string, args: OpArgs<"wake">): Promise<number> {
  const lane = readLaneConfig(home);
  if (lane === undefined) throw new Error(`${home} is not a lane home`);
  const wake = check(OPS.wake.args, args);
  const { value: token, note } = await laneToken(lane, bwsFor(lane.bws));
  if (token === undefined) throw new Error(`fleet: ${note}`);
  if (lane.bws !== undefined) console.error(`fleet: ${note}`);
  const url = lane.url.replace(/^ws/, "http").replace(/\/session$/, "/call");
  const response = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ op: "wake", args: wake }),
  });
  const outcome = check(HttpOutcomeSchema, await response.json());
  if (!outcome.ok) throw new Error(outcome.error);
  return check(OPS.wake.result, outcome.value).entry;
}
