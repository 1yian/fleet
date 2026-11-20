import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { startFleet, type Fleet } from "../support/fleet.ts";
import { Harness } from "../support/harness.ts";

const EXTENSION = fileURLToPath(new URL("../../packages/extension/src/index.ts", import.meta.url));
const CHAIN = ["openai-codex/gpt-fixture:medium"];
const TIERS = {
  default: { description: "Build or fix from a known plan, spec, or reproduction.", chain: CHAIN },
  deep: { description: "Open-ended investigation and hard design problems.", chain: CHAIN },
  visual: {
    description: "Work judged mainly on how it looks: video, images, and UI visuals.",
    chain: CHAIN,
  },
  quick: { chain: CHAIN },
};
const ROUTER = { classifier: "typesafe/jev-latest" };

let fleet: Fleet;
let h: Harness;
beforeEach(async () => {
  fleet = await startFleet();
  h = await Harness.start();
  mkdirSync(join(h.dir, "agent"), { recursive: true });
});
afterEach(async () => {
  await h.stop();
  await fleet.cardd.stop();
});

async function mateSystem(config: unknown, jevKey: string): Promise<string> {
  if (config !== undefined)
    writeFileSync(join(h.dir, "agent", "tiers.json"), JSON.stringify(config));
  h.onModel(() => ({ text: "ready" }));
  const token = fleet.cardd.addLane("cleo", "main");
  const mate = h.startPi(
    "cleo",
    {
      FLEET_URL: fleet.cardd.url,
      FLEET_TOKEN: token,
      FLEET_ROLE: "mate",
      TYPESAFE_API_KEY: jevKey,
    },
    [EXTENSION],
  );
  await h.waitFor((event) => event["type"] === "fleet_connected", "the mate to connect");
  mate.prompt("Are you there?");
  const turns = await h.waitForCall(0);
  return turns.find((turn) => turn.role === "system")?.text ?? "";
}

const offered = (system: string): string[] =>
  [...system.matchAll(/^- (tier\/[^\s:]+)/gm)].map((found) => found[1] ?? "");

test("with no auto section in tiers.json, the mate is shown every tier the file defines, and no other", async () => {
  const system = await mateSystem({ tiers: TIERS }, "");
  assert.match(system, /## Worker tiers\nNo tier router works on this install/);
  assert.deepEqual(offered(system), ["tier/default", "tier/deep", "tier/visual", "tier/quick"]);
  assert.match(
    system,
    /- tier\/visual: Work judged mainly on how it looks: video, images, and UI visuals\./,
  );
  assert.match(system, /^- tier\/quick$/m);
});

test("with a router whose classifier has no credentials, the mate is shown the tiers", async () => {
  const system = await mateSystem({ tiers: TIERS, auto: ROUTER }, "");
  assert.deepEqual(offered(system), ["tier/default", "tier/deep", "tier/visual", "tier/quick"]);
});

test("with a router whose classifier works, the mate is shown no tiers and leaves the choice to the router", async () => {
  const system = await mateSystem({ tiers: TIERS, auto: ROUTER }, "fixture-key");
  assert.equal(system.includes("## Worker tiers"), false);
});

test("with no tiers.json, the mate is shown no tiers", async () => {
  const system = await mateSystem(undefined, "");
  assert.equal(system.includes("## Worker tiers"), false);
});
