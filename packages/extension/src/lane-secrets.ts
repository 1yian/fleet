import { Bws, resolveSecret, type BwsConfig, type Lookup, type Resolved } from "./bws.ts";

const LANE_TOKEN_KEY = "FLEET_LANE_TOKEN";
const LANE_FILE_NAME = "config/lane.json";

export const bwsFor = (config: BwsConfig | undefined): Bws | undefined =>
  config === undefined ? undefined : new Bws(config);

export function laneToken(
  lane: { readonly token?: string | undefined; readonly bws?: BwsConfig | undefined },
  bws: Bws | undefined,
): Promise<Resolved> {
  return resolveSecret(bws, "lane token", lane.bws?.laneToken ?? LANE_TOKEN_KEY, {
    value: lane.token,
    from: LANE_FILE_NAME,
  });
}

export async function applyEnvSecrets(
  bws: Bws | undefined,
  env: Readonly<Record<string, string>>,
): Promise<string[]> {
  const notes: string[] = [];
  for (const [name, reference] of Object.entries(env)) {
    const { value, note } = await resolveSecret(bws, name, reference, {
      value: process.env[name],
      from: "the environment",
    });
    if (value !== undefined) process.env[name] = value;
    notes.push(note);
  }
  return notes;
}

interface Check {
  readonly name: string;
  readonly reference: string;
  readonly file?: { readonly token: string | undefined };
}

function describe(check: Check, found: Lookup): string {
  const { file } = check;
  if (!found.found) {
    const next =
      file === undefined
        ? ""
        : file.token === undefined
          ? `, and ${LANE_FILE_NAME} has no token`
          : `, so ${LANE_FILE_NAME} would be used`;
    return `bws failed (${found.why})${next}`;
  }
  const same =
    file === undefined
      ? ""
      : file.token === undefined
        ? `, ${LANE_FILE_NAME} has no token`
        : file.token === found.value
          ? `, the same as ${LANE_FILE_NAME}`
          : `, different from ${LANE_FILE_NAME}`;
  return `bws ok (${found.where})${same}`;
}

export async function checkLaneSecrets(lane: {
  readonly lane: string;
  readonly token?: string | undefined;
  readonly bws?: BwsConfig | undefined;
}): Promise<{ lines: string[]; failed: boolean }> {
  const { bws: config } = lane;
  if (config === undefined)
    return {
      lines: [`${lane.lane}: no bws block, so the lane token comes from ${LANE_FILE_NAME}`],
      failed: false,
    };
  const client = new Bws(config);
  const checks: Check[] = [
    {
      name: "lane token",
      reference: config.laneToken ?? LANE_TOKEN_KEY,
      file: { token: lane.token },
    },
    ...Object.entries(config.env).map(([name, reference]) => ({ name, reference })),
  ];
  const lines: string[] = [];
  let failed = false;
  for (const check of checks) {
    const found = await client.lookup(check.reference);
    failed ||= !found.found;
    lines.push(`${lane.lane}: ${check.name}: ${describe(check, found)}`);
  }
  return { lines, failed };
}
