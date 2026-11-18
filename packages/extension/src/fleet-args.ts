export function fleetArgs({
  url,
  token,
  role,
  avoid = [],
  repo,
}: {
  url: string;
  token: string;
  role: "worker" | "mate";
  avoid?: readonly string[];
  repo?: string | undefined;
}): string[] {
  const args = [`--fleet-url=${url}`, `--fleet-token=${token}`, `--fleet-role=${role}`];
  if (repo !== undefined) args.push(`--fleet-repo=${repo}`);
  if (avoid.length > 0) args.push(`--fleet-avoid=${avoid.join(",")}`);
  return args;
}
