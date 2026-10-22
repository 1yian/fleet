import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { Cardd, type Session } from "../support/cardd.ts";
import { Harness } from "../support/harness.ts";
import { HerdrLab } from "../support/herdr.ts";
import { settingsArgs, Scratch } from "../support/scratch.ts";

const WAIT_MS = 60_000;
const PROBE = fileURLToPath(new URL("../support/probe.ts", import.meta.url));
const BIN = fileURLToPath(new URL("../../node_modules/.bin", import.meta.url));

let cardd: Cardd;
let h: Harness;
let lab: HerdrLab;
let scratch: Scratch;
let main: Session;
beforeEach(async () => {
  cardd = await Cardd.start();
  h = await Harness.start();
  scratch = new Scratch();
  main = await cardd.connect(cardd.addLane("main", undefined, scratch.root));
  mkdirSync(join(h.dir, "agent"), { recursive: true });
  writeFileSync(
    join(h.dir, "agent", "settings.json"),
    JSON.stringify({ defaultProvider: "tier", defaultModel: "auto" }),
  );
  writeFileSync(
    join(h.dir, "agent", "models.json"),
    JSON.stringify({ providers: { tier: { apiKey: "scripted" } } }),
  );
  lab = await HerdrLab.start({ ...h.piEnv("mate"), PATH: `${BIN}:${process.env["PATH"] ?? ""}` });
});
afterEach(async (t) => {
  await lab.printIfFailed(t);
  const stopped = await Promise.allSettled([main.close(), lab.stop(), h.stop(), cardd.stop()]);
  scratch.dispose();
  const failed = stopped.find((result) => result.status === "rejected");
  if (failed !== undefined) throw new Error(`cleanup failed: ${String(failed.reason)}`);
});

const startsOn = async (): Promise<string[]> => {
  const models = h.modelsOf("mate");
  await main.call("comment", { lane: "cnp", text: "Are you there?" });
  await h.waitForCall(models.length, "mate", WAIT_MS);
  return h.modelsOf("mate");
};

async function verifyMate(args: string[], selected: string): Promise<void> {
  const token = cardd.addLane("cnp", "main");
  scratch.addLane("cnp", {
    url: cardd.url,
    token,
    args: [...settingsArgs(h), "-e", PROBE, ...args],
  });
  const fleet = (...args: string[]): string =>
    scratch.fleet(args, { ...h.piEnv("mate"), HERDR_SESSION: lab.name });

  assert.match(fleet("up", "cnp"), /cnp: started/);
  await h.waitFor((event) => event["type"] === "fleet_connected", "the mate to join the fleet");
  assert.deepEqual(await startsOn(), [selected]);

  assert.match(fleet("restart", "cnp"), /cnp: started/);
  await h.waitForNth(
    (event) => event["type"] === "fleet_connected",
    2,
    "the mate to join again after the restart",
  );
  assert.deepEqual(await startsOn(), [selected, selected]);
}

test("a second mate defaults to orchestrator, including after restart", async () => {
  await verifyMate([], "tier/orchestrator");
});

test("a second mate preserves explicit Vertex routing, including after restart", async () => {
  await verifyMate(
    ["--provider", "google-vertex", "--model", "gemini-2.5-pro"],
    "google-vertex/gemini-2.5-pro",
  );
});

test("a second mate preserves a provider-qualified explicit model", async () => {
  await verifyMate(["--model", "google-vertex/gemini-2.5-pro"], "google-vertex/gemini-2.5-pro");
});
