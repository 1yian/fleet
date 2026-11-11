import { readFileSync } from "node:fs";
import { join } from "node:path";

const LOOPBACK = /^(127\.\d{1,3}\.\d{1,3}\.\d{1,3}|localhost):(\d{1,5})$/;

export function loopbackAddress(spec: string): string | undefined {
  return LOOPBACK.test(spec) ? spec : undefined;
}

export function upstreamOf(spec: string): () => string {
  const fixed = loopbackAddress(spec);
  if (fixed !== undefined) return () => fixed;
  return () => {
    const first = readFileSync(join(spec, "DevToolsActivePort"), "utf8").split("\n")[0] ?? "";
    if (!/^\d{1,5}$/.test(first)) throw new Error(`${spec}/DevToolsActivePort names no port`);
    return `127.0.0.1:${first}`;
  };
}
