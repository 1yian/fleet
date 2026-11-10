import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { begin, newCard, startFleet, type Fleet } from "../support/fleet.ts";
import { Harness, type Turn } from "../support/harness.ts";

const EXTENSION = fileURLToPath(new URL("../../packages/extension/src/index.ts", import.meta.url));

let fleet: Fleet;
let h: Harness;

beforeEach(async () => {
  fleet = await startFleet();
  h = await Harness.start();
});
afterEach(async () => {
  const stopped = await Promise.allSettled([h.stop(), fleet.cardd.stop()]);
  const failed = stopped.find((result) => result.status === "rejected");
  if (failed !== undefined) throw new Error(`cleanup failed: ${String(failed.reason)}`);
});

const lastText = (turns: Turn[] | undefined): string => turns?.at(-1)?.text ?? "";

const pathWithoutAnyBrowserAxi = (): string =>
  (process.env["PATH"] ?? "")
    .split(delimiter)
    .filter((dir) => !existsSync(join(dir, "browser-axi")))
    .join(delimiter);

test("a worker that calls browser-axi gets command not found, its PATH holds only the kill guards of the fleet, and its contract has no browser rule", async () => {
  h.onModel(() => ({
    tool: "bash",
    args: { command: 'browser-axi open https://example.com 2>&1; echo "exit $?"' },
  }));
  h.onModel(() => ({ tool: "bash", args: { command: 'ls "$(dirname "$(command -v pkill)")"' } }));
  h.onModel(() => ({
    tool: "report",
    args: { status: "done", text: "no browser to use, carried on without it" },
  }));
  const card = await newCard(fleet.main, "Check the deployed page");
  const token = await begin(fleet.main, card, "check the deployed page");
  h.startPi(
    `c-${String(card.id)}-a1`,
    {
      FLEET_URL: fleet.cardd.url,
      FLEET_TOKEN: token,
      FLEET_ROLE: "worker",
      PATH: pathWithoutAnyBrowserAxi(),
    },
    [EXTENSION],
    [],
    true,
  );
  await fleet.main.waitForEntries(1);

  assert.match(lastText(h.calls[1]), /browser-axi: .*not found\s+exit 127/s);
  assert.deepEqual(lastText(h.calls[2]).trim().split(/\s+/), ["killall", "pkill"]);
  const contract = h.calls[0]?.find((turn) => turn.role === "system")?.text ?? "";
  assert.match(contract, /Never create, remove, move, or prune a worktree/);
  assert.doesNotMatch(contract, /browser/i);
});
