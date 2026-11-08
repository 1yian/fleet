import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { begin, newCard, startFleet, type Fleet } from "../support/fleet.ts";
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
  writeFileSync(
    file,
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "${touched}"\nprintf 'isolated maintenance complete\\n'\n`,
  );
  chmodSync(file, 0o755);
});
afterEach(async () => {
  const stopped = await Promise.allSettled([h.stop(), fleet.cardd.stop()]);
  const failed = stopped.find((result) => result.status === "rejected");
  if (failed !== undefined) throw new Error(`cleanup failed: ${String(failed.reason)}`);
});

test("a mate can execute explicitly authorized daemon maintenance", async () => {
  h.onModel(() => ({ tool: "bash", args: { command: "no-mistakes daemon restart --force" } }));
  h.onModel(() => ({ text: "maintenance complete" }));
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
  mate.prompt(
    "Explicit approval: restart the isolated test daemon after preserving active-run evidence.",
  );
  await h.waitForCall(1);

  assert.match(JSON.stringify(h.calls[1]), /isolated maintenance complete/);
  assert.equal(readFileSync(touched, "utf8"), "daemon restart --force\n");
});

test("a worker can execute scoped maintenance through its ordinary shell", async () => {
  const commands = ["start", "stop", "restart", "update"];
  for (const command of commands)
    h.onModel(() => ({ tool: "bash", args: { command: `no-mistakes daemon ${command}` } }));
  h.onModel(() => ({
    tool: "report",
    args: { status: "done", text: "isolated maintenance complete" },
  }));
  const card = await newCard(fleet.main, "Authorized isolated daemon maintenance");
  const token = await begin(
    fleet.main,
    card,
    "Explicit approval for start, stop, restart and update of the isolated test daemon; active-run evidence is preserved.",
  );
  h.startPi(
    `c-${String(card.id)}-a1`,
    {
      FLEET_URL: fleet.cardd.url,
      FLEET_TOKEN: token,
      FLEET_ROLE: "worker",
      PATH: `${bin}:${process.env["PATH"] ?? ""}`,
    },
    [EXTENSION, SHELL],
    [],
    true,
  );
  await fleet.main.waitForEntries(1);
  assert.equal(
    readFileSync(touched, "utf8"),
    "daemon start\ndaemon stop\ndaemon restart\ndaemon update\n",
  );
});
