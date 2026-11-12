import type { OpArgs } from "@fleet/protocol";
import { callCardd } from "./cardd-call.ts";
import { readLaneConfig } from "./lane-config.ts";

export async function wakeMate(home: string, args: OpArgs<"wake">): Promise<number> {
  const lane = readLaneConfig(home);
  if (lane === undefined) throw new Error(`${home} is not a lane home`);
  return (await callCardd(lane, "wake", args)).entry;
}
