import { parseArgs } from "node:util";
import { serve } from "./serve.ts";
import { loopbackAddress, upstreamOf } from "./upstream.ts";
import { Watch } from "./watch.ts";

const USAGE =
  "usage: guard.ts --chrome <127.0.0.1:port | profile directory> [--listen 127.0.0.1:9222]";

function listenAddress(spec: string): { host: string; port: number } {
  const address = loopbackAddress(spec) ?? (/^\[::1\]:\d{1,5}$/.test(spec) ? spec : undefined);
  if (address === undefined)
    throw new Error(`--listen ${spec} must be a loopback address such as 127.0.0.1:9222`);
  const split = address.lastIndexOf(":");
  return {
    host: address.slice(0, split).replace(/^\[|\]$/g, ""),
    port: Number(address.slice(split + 1)),
  };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { listen: { type: "string", default: "127.0.0.1:9222" }, chrome: { type: "string" } },
  });
  if (values.chrome === undefined) throw new Error(USAGE);
  const { host, port } = listenAddress(values.listen);
  const upstream = upstreamOf(values.chrome);
  const watch = new Watch(() => `http://${upstream()}`);
  watch.start();
  const served = await serve(host, port, upstream, watch);
  console.error(`guard: listening on ${host}:${String(port)} in front of ${values.chrome}`);
  const stop = (): void => {
    watch.stop();
    void served.close().then(() => process.exit(0));
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
