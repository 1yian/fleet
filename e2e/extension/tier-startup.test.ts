import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { Cardd } from "../support/cardd.ts";
import { FakeBws } from "../support/bws.ts";
import { Harness } from "../support/harness.ts";
import { HerdrLab } from "../support/herdr.ts";
import { configureMain, mateArgs, Scratch, startMain } from "../support/scratch.ts";

const WAIT_MS = 120_000;
const BIN = fileURLToPath(new URL("../../node_modules/.bin", import.meta.url));
const TIERS = [
  "default",
  "nm-default",
  "nm-fixer",
  "deep",
  "research",
  "visual",
  "watch",
  "quick",
  "orchestrator",
  "weaker-orchestrator",
  "compact",
  "reviewer",
];

let cardd: Cardd;
let h: Harness;
let lab: HerdrLab;
let scratch: Scratch;
let mainToken: string;
let bws: FakeBws;
beforeEach(async () => {
  cardd = await Cardd.start();
  h = await Harness.start();
  scratch = new Scratch();
  mainToken = cardd.addLane("main");
  scratch.addLane("cleo", {
    url: cardd.url,
    token: cardd.addLane("cleo", "main"),
    args: mateArgs(h),
  });
  bws = new FakeBws([{ name: "main", secrets: {} }]);
  bws.failWith("simulated outage");
  lab = await HerdrLab.start({
    ...h.piEnv("mate"),
    ...bws.env,
    PATH: `${BIN}:${bws.env["PATH"] ?? ""}`,
  });
});
afterEach(async (t) => {
  await lab.printIfFailed(t);
  const stopped = await Promise.allSettled([lab.stop(), h.stop(), cardd.stop()]);
  scratch.dispose();
  const failed = stopped.find((result) => result.status === "rejected");
  if (failed !== undefined) throw new Error(`cleanup failed: ${String(failed.reason)}`);
});

const squeezed = (text: string): string => text.replace(/\s+/g, "");

async function waitForSurfaces(pane: string, status: string, label: string): Promise<void> {
  const wanted = squeezed(status);
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const screen = squeezed(await lab.screen(pane));
    if (screen.split(wanted).length - 1 === 2) return;
    assert.ok(
      Date.now() < deadline,
      `timed out waiting for both the footer and the widget to show ${label}`,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function waitForScreenWithout(pane: string, unwanted: string, label: string): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    if (!squeezed(await lab.screen(pane)).includes(squeezed(unwanted))) return;
    assert.ok(Date.now() < deadline, `timed out waiting for the screen to drop ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const template = (): string =>
  join(realpathSync(scratch.root), "packages/extension/templates/tiers.json");

test("fleet up reads PI_TIERS_CONFIG set to an empty string as the default tiers file", () => {
  const agent = join(h.dir, "default-tiers");
  mkdirSync(agent);
  copyFileSync(template(), join(agent, "tiers.json"));
  const env = { HERDR_SESSION: lab.name, PI_CODING_AGENT_DIR: agent, PI_TIERS_CONFIG: "" };
  assert.equal(scratch.fleet(["up"], env), "cleo: started in 2ndmate-cleo\n");
});

test("main started directly with pi names every missing tier, does not join the fleet, and joins once they are configured", async () => {
  configureMain(scratch, cardd.url, mainToken);
  const file = join(h.dir, "agent", "tiers.json");
  const tiers: Record<string, { chain: string[] }> = {};
  for (const name of TIERS)
    if (name !== "nm-fixer" && name !== "reviewer") tiers[name] = { chain: ["fake/scripted"] };
  writeFileSync(file, JSON.stringify({ tiers }));
  h.onModel(() => ({ text: "noted" }), "mate");
  const pane = await startMain(lab, scratch, h);
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const history = (await lab.history(pane)).replace(/\s+/g, "");
    if (history.includes("Missingtiers(2):nm-fixer,reviewer.")) break;
    assert.ok(Date.now() < deadline, "timed out waiting for the pane to name both missing tiers");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(
    h.events.some((event) => event["type"] === "fleet_connected"),
    false,
  );
  const status = "fleet: not joined - tiers file invalid (2 tiers not declared):";
  await waitForSurfaces(pane, status, "the not-joined status");

  copyFileSync(template(), file);
  await lab.submit(pane, "/probe-reload");
  await h.waitFor((event) => event["type"] === "fleet_connected", "main to join the fleet");
  await waitForScreenWithout(pane, "not joined - tiers", "the not-joined status");
});

test("main tells a missing tiers file from an invalid one in its status line", async () => {
  configureMain(scratch, cardd.url, mainToken);
  const file = join(h.dir, "agent", "tiers.json");
  rmSync(file);
  const pane = await startMain(lab, scratch, h);
  await waitForSurfaces(
    pane,
    `fleet: not joined - tiers file missing (${String(TIERS.length)} tiers):`,
    "the missing-file status",
  );

  writeFileSync(file, "{ not json");
  await lab.submit(pane, "/probe-reload");
  await waitForSurfaces(
    pane,
    `fleet: not joined - tiers file invalid (not valid JSON):`,
    "the invalid-file status",
  );
  assert.equal(
    h.events.some((event) => event["type"] === "fleet_connected"),
    false,
  );
});

test("main names every missing tier even when its lane token cannot be read", async () => {
  configureMain(scratch, cardd.url, undefined, {
    bws: { tokenFile: bws.tokenFile, project: bws.projectId("main"), env: {} },
  });
  writeFileSync(join(h.dir, "agent", "tiers.json"), JSON.stringify({ tiers: {} }));
  const pane = await startMain(lab, scratch, h);
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const history = (await lab.history(pane)).replace(/\s+/g, "");
    if (history.includes("Missingtiers(12):default,nm-default,nm-fixer,")) break;
    assert.ok(Date.now() < deadline, "timed out waiting for the pane to name the missing tiers");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
});
