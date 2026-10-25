import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CODEMODE_TOOL = "codemode";
const CODEMODE_WORKERS = "4";

export function enableCodemode(pi: ExtensionAPI): void {
  process.env["PI_CODEMODE_MAX_WORKERS"] ??= CODEMODE_WORKERS;
  const active = pi.getActiveTools();
  if (active.includes(CODEMODE_TOOL)) return;
  pi.setActiveTools([...active, CODEMODE_TOOL]);
}
