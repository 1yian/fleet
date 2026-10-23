import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { startFleet, type Fleet } from "../support/fleet.ts";
import { Harness } from "../support/harness.ts";

const EXTENSION = fileURLToPath(new URL("../../packages/extension/src/index.ts", import.meta.url));
const SHELL = fileURLToPath(new URL("../support/shell-tool.ts", import.meta.url));

let fleet: Fleet;
let h: Harness;
let bin: string;
let touched: string;

beforeEach(async () => {
  fleet = await startFleet({});
  h = await Harness.start();
  bin = join(h.dir, "bin");
  touched = join(h.dir, "daemon-touched");
  mkdirSync(bin);
  const file = join(bin, "no-mistakes");
  writeFileSync(file, `#!/bin/sh\ntouch "${touched}"\n`);
  chmodSync(file, 0o755);
});
afterEach(async () => {
  const stopped = await Promise.allSettled([h.stop(), fleet.cardd.stop()]);
  const failed = stopped.find((result) => result.status === "rejected");
  if (failed !== undefined) throw new Error(`cleanup failed: ${String(failed.reason)}`);
});

test("a mate is refused a daemon admin command", async () => {
  h.onModel(() => ({ tool: "bash", args: { command: "no-mistakes daemon restart --force" } }));
  h.onModel(() => ({ text: "refused" }));
  const mate = h.startPi(
    "main-mate",
    {
      FLEET_URL: fleet.cardd.url,
      FLEET_TOKEN: fleet.mainToken,
      FLEET_ROLE: "mate",
      PATH: `${bin}:${process.env["PATH"] ?? ""}`,
    },
    [EXTENSION, SHELL],
  );
  await h.waitFor((e) => e["type"] === "fleet_connected", "the mate to connect");
  mate.prompt("restart the daemon");
  await h.waitForCall(1);

  assert.match(JSON.stringify(h.calls[1]), /refused: the no-mistakes daemon is shared/);
  assert.equal(existsSync(touched), false);
});
