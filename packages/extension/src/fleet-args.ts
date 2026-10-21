export function fleetArgs({
  url,
  token,
  role,
}: {
  url: string;
  token: string;
  role: "worker" | "mate";
}): string[] {
  return [`--fleet-url=${url}`, `--fleet-token=${token}`, `--fleet-role=${role}`];
}
