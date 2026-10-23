export function fleetArgs({
  url,
  token,
  role,
  avoid = [],
}: {
  url: string;
  token: string;
  role: "worker" | "mate";
  avoid?: readonly string[];
}): string[] {
  const args = [`--fleet-url=${url}`, `--fleet-token=${token}`, `--fleet-role=${role}`];
  return avoid.length === 0 ? args : [...args, `--fleet-avoid=${avoid.join(",")}`];
}
