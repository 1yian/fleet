// The Pi arguments that put a session in the fleet. index.ts reads them.
// Each value follows "=" in its flag. Pi reads a separate value that begins
// with "-" as an option, and 1 cardd token in 64 begins with "-".

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
