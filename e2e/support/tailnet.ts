import { writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { tempDir } from "./run-root.ts";

export const lanAddress = (): string | undefined =>
  Object.values(networkInterfaces())
    .flat()
    .find((each) => each?.family === "IPv4" && !each.internal)?.address;

export function tailnetCommand(address: string, name = ""): { FLEET_TAILSCALE: string } {
  const status = {
    BackendState: "Running",
    Self: { DNSName: name, TailscaleIPs: [address] },
  };
  const file = join(tempDir("fleet-tailnet-"), "tailscale");
  writeFileSync(file, `#!/bin/sh\necho '${JSON.stringify(status)}'\n`, { mode: 0o755 });
  return { FLEET_TAILSCALE: file };
}
