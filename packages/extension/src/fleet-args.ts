import { PROCESS_ARG } from "./process-id.ts";

export const TRUST_ARG = "--approve";

export function fleetArgs({
  url,
  token,
  role,
  avoid = [],
  fleetProject,
  launch,
}: {
  url: string;
  token: string;
  role: "worker" | "mate";
  avoid?: readonly string[];
  fleetProject?: boolean | undefined;
  launch?: string | undefined;
}): string[] {
  const args = [`--fleet-url=${url}`, `--fleet-token=${token}`, `--fleet-role=${role}`];
  if (fleetProject !== undefined) args.push(`--fleet-project=${String(fleetProject)}`);
  if (launch !== undefined) args.push(`${PROCESS_ARG}${launch}`);
  if (avoid.length > 0) args.push(`--fleet-avoid=${avoid.join(",")}`);
  return args;
}
