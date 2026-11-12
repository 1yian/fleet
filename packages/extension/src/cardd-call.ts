import {
  check,
  HttpOutcomeSchema,
  OPS,
  type OpArgs,
  type OpName,
  type OpResult,
} from "@fleet/protocol";
import { type LaneConfig } from "./lane-config.ts";
import { bwsFor, laneToken } from "./lane-secrets.ts";

function checkResult<N extends OpName>(op: N, value: unknown): OpResult<N>;
function checkResult(op: OpName, value: unknown): unknown {
  return check(OPS[op].result, value);
}

export const carddHttp = (lane: LaneConfig, path: string): string =>
  lane.url.replace(/^ws/, "http").replace(/\/session$/, path);

export async function callCardd<N extends OpName>(
  lane: LaneConfig,
  op: N,
  args: OpArgs<N>,
): Promise<OpResult<N>> {
  const checked = check(OPS[op].args, args);
  const { value: token, note } = await laneToken(lane, bwsFor(lane.bws));
  if (token === undefined) throw new Error(`fleet: ${note}`);
  if (lane.bws !== undefined) console.error(`fleet: ${note}`);
  const response = await fetch(carddHttp(lane, "/call"), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ op, args: checked }),
  });
  const outcome = check(HttpOutcomeSchema, await response.json());
  if (!outcome.ok) throw new Error(outcome.error);
  return checkResult(op, outcome.value);
}
