import { check, HttpOutcomeSchema, OPS, type OpArgs } from "@fleet/protocol";
import { readLaneConfig } from "./lane-config.ts";

export async function wakeMate(home: string, args: OpArgs<"wake">): Promise<number> {
  const lane = readLaneConfig(home);
  if (lane === undefined) throw new Error(`${home} is not a lane home`);
  const wake = check(OPS.wake.args, args);
  const url = lane.url.replace(/^ws/, "http").replace(/\/session$/, "/call");
  const response = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${lane.token}`, "content-type": "application/json" },
    body: JSON.stringify({ op: "wake", args: wake }),
  });
  const outcome = check(HttpOutcomeSchema, await response.json());
  if (!outcome.ok) throw new Error(outcome.error);
  return check(OPS.wake.result, outcome.value).entry;
}
