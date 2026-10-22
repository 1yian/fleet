import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { Cardd, type Session } from "../support/cardd.ts";
import { Harness } from "../support/harness.ts";
import { HerdrLab } from "../support/herdr.ts";
import { mateArgs, Scratch } from "../support/scratch.ts";

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

test("a second mate whose lane asks for another model starts on the orchestrator tier, and again after a restart", async () => {
  const token = cardd.addLane("cnp", "main");
  scratch.addLane("cnp", {
    url: cardd.url,
    token,
    args: [...mateArgs(h), "-e", PROBE, "--provider", "tier", "--model", "auto"],
  });
  const fleet = (...args: string[]): string =>
    scratch.fleet(args, { ...h.piEnv("mate"), HERDR_SESSION: lab.name });

  assert.match(fleet("up", "cnp"), /cnp: started/);
  await h.waitFor((event) => event["type"] === "fleet_connected", "the mate to join the fleet");
  assert.deepEqual(await startsOn(), ["tier/orchestrator"]);

  assert.match(fleet("restart", "cnp"), /cnp: started/);
  await h.waitForNth(
    (event) => event["type"] === "fleet_connected",
    2,
    "the mate to join again after the restart",
  );
  assert.deepEqual(await startsOn(), ["tier/orchestrator", "tier/orchestrator"]);
});
