import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { begin, newCard, startFleet } from "../support/fleet.ts";
import { Harness } from "../support/harness.ts";

const EXTENSION = fileURLToPath(new URL("../../packages/extension/src/index.ts", import.meta.url));

test("a worker receives the stock browser CLI contract instead of a dedicated fleet browser", async (t) => {
  const fleet = await startFleet();
  t.after(() => fleet.cardd.stop());
  const h = await Harness.start();
  t.after(() => h.stop());
  h.onModel(() => ({
    tool: "report",
    args: { status: "done", text: "worker received its browser instructions" },
  }));
  const card = await newCard(fleet.main, "Read the worker browser contract");
  const token = await begin(fleet.main, card, "Read your browser instructions");
  h.startPi(
    `c-${String(card.id)}-a1`,
    {
      FLEET_URL: fleet.cardd.url,
      FLEET_TOKEN: token,
      FLEET_ROLE: "worker",
    },
    [EXTENSION],
  );
  await fleet.main.waitForEntries(1);
  const contract = h.calls[0]?.find((turn) => turn.role === "system")?.text ?? "";
  assert.match(contract, /Use `chrome-devtools-axi` through bash/);
  assert.match(contract, /CHROME_DEVTOOLS_AXI_SESSION=fleet-c-<card>-a<attempt>/);
  assert.match(contract, /Stop only your own named session/);
  assert.match(contract, /Never drive Safari/);
  assert.match(contract, /If the CLI or Chrome is unavailable, report the missing prerequisite/);
  assert.doesNotMatch(contract, /browser-axi|fleet-attach|fleet-chrome|Xpra/);
});
