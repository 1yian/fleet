export const TRUST_ARG = "--approve";

export function fleetArgs({
  url,
  token,
  role,
  avoid = [],
  fleetProject,
}: {
  url: string;
  token: string;
  role: "worker" | "mate";
  avoid?: readonly string[];
  fleetProject?: boolean | undefined;
}): string[] {
  const args = [`--fleet-url=${url}`, `--fleet-token=${token}`, `--fleet-role=${role}`];
  if (fleetProject !== undefined) args.push(`--fleet-project=${String(fleetProject)}`);
  if (avoid.length > 0) args.push(`--fleet-avoid=${avoid.join(",")}`);
  return args;
}
