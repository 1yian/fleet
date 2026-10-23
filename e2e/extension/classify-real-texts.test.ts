import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import type { Entry } from "@fleet/protocol";
import { startFleet, type Fleet } from "../support/fleet.ts";
import { Harness } from "../support/harness.ts";

const EXTENSION = fileURLToPath(new URL("../../packages/extension/src/index.ts", import.meta.url));

let fleet: Fleet;
let h: Harness;
beforeEach(async () => {
  fleet = await startFleet({ CARDD_TIMING_SCALE: "0.02" });
  h = await Harness.start();
});
afterEach(async () => {
  await h.stop();
  await fleet.cardd.stop();
});

const isFailure = (entry: Entry): boolean => entry.fields["condition"] === "runtime-failure";

test("real router exhaustion and payment texts from a failing model turn are classified, with a delay for the cooldown", async () => {
  const texts: [string, string, RegExp][] = [
    [
      "pi-tiers: no usable model for tier 'orchestrator' (anthropic/claude-opus-5-5 on anthropic: cooling, openai/gpt-5 on openai: cooling)",
      "router-cooldown",
      /mode=retry\), eligible at/,
    ],
    [
      "API error (status 402 Payment Required): Grok credits exhausted",
      "vendor-quota",
      /Restarting is not a repair for vendor-quota/,
    ],
  ];
  const names = texts.map((_, index) => ["cleo", "dara"][index] ?? "eli");
  for (const [index, [error]] of texts.entries()) {
    const name = names[index] ?? "";
    const token = fleet.cardd.addLane(name, "main");
    for (let call = 0; call < 3; call += 1) h.onModel(() => ({ fail: error }), name);
    const mate = h.startPi(
      name,
      {
        FLEET_URL: fleet.cardd.url,
        FLEET_TOKEN: token,
        FLEET_ROLE: "mate",
        FLEET_FAKE_AGENT: name,
      },
      [EXTENSION],
    );
    mate.prompt("hello");
  }
  for (const [index, [, kind, next]] of texts.entries()) {
    const name = names[index] ?? "";
    const heard = await fleet.main.waitForEntry(
      (entry) => isFailure(entry) && entry.body.includes(`runtime failure: ${name} `),
      kind,
    );
    assert.match(heard.body, new RegExp(`Classified ${kind}\\.`));
    assert.match(heard.body, next);
  }
});
