// A lane whose settings name a direnv folder (docs/setup.md): its mate runs with that folder's
// environment, while its home stays where it is. The folder is a scratch folder with its own
// .envrc, which a scratch direnv configuration trusts. Its .envrc sets the name that the scripted model
// files the mate's calls under, so a call under that name proves the mate got the environment.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { Cardd } from "../support/cardd.ts";
import { Harness } from "../support/harness.ts";
import { HerdrLab } from "../support/herdr.ts";
import { mateArgs, Scratch } from "../support/scratch.ts";

const WAIT_MS = 60_000;
const BIN = fileURLToPath(new URL("../../node_modules/.bin", import.meta.url));
const PROBE = fileURLToPath(new URL("../support/probe.ts", import.meta.url));
const ENV_AGENT = "from-envrc";

let cardd: Cardd;
let h: Harness;
let lab: HerdrLab;
let scratch: Scratch;
let dir: string;
let env: Record<string, string>;
beforeEach(async () => {
  cardd = await Cardd.start();
  h = await Harness.start();
  scratch = new Scratch();
  dir = mkdtempSync(join(tmpdir(), "fleet-direnv-"));
  // direnv reads its configuration from DIRENV_CONFIG. The scratch one trusts only the test's folder.
  env = { DIRENV_CONFIG: join(dir, "direnv") };
  lab = await HerdrLab.start({
    ...h.piEnv("mate"),
    ...env,
    PATH: `${BIN}:${process.env["PATH"] ?? ""}`,
  });
});
afterEach(async (t) => {
  await lab.printIfFailed(t);
  const stopped = await Promise.allSettled([lab.stop(), h.stop(), cardd.stop()]);
  scratch.dispose();
  rmSync(dir, { recursive: true, force: true });
  const failed = stopped.find((result) => result.status === "rejected");
  if (failed !== undefined) throw new Error(`cleanup failed: ${String(failed.reason)}`);
});

const fleet = (...args: string[]): string =>
  scratch.fleet(args, { ...env, HERDR_SESSION: lab.name });

test("a lane with a direnv folder starts and restarts its mate with that folder's environment", async (t) => {
  const folder = join(realpathSync(dir), "work");
  mkdirSync(folder);
  writeFileSync(join(folder, ".envrc"), `export FLEET_FAKE_AGENT=${ENV_AGENT}\n`);
  const trust = `[whitelist]\nexact = [${JSON.stringify(join(folder, ".envrc"))}]\n`;
  mkdirSync(join(dir, "direnv"));
  writeFileSync(join(dir, "direnv", "direnv.toml"), trust);
  const mainToken = cardd.addLane("main");
  const home = scratch.addLane("cnp", {
    url: cardd.url,
    token: cardd.addLane("cnp", "main"),
    args: [...mateArgs(h), "-e", PROBE],
    direnv: folder,
  });
  assert.ok(!home.startsWith(folder), "the home moved into the direnv folder");
  const main = await cardd.connect(mainToken);
  t.after(() => main.close());

  assert.match(fleet("up", "cnp"), /cnp: started/);
  await h.waitFor((event) => event["type"] === "fleet_connected", "the mate to join the fleet");
  // fleet sees the mate under direnv as running, so the minute loop does not start it again.
  assert.deepEqual(JSON.parse(fleet("status", "--json")), [{ lane: "cnp", state: "running" }]);
  await main.call("comment", { lane: "cnp", text: "Are you there?" });
  const first = await h.waitForCall(0, ENV_AGENT, WAIT_MS);
  assert.match(first.map((turn) => turn.text).join("\n"), /Are you there\?/);

  assert.match(fleet("restart", "cnp"), /cnp: started/);
  await h.waitForNth(
    (event) => event["type"] === "fleet_connected",
    2,
    "the mate to join again after the restart",
  );
  await main.call("comment", { lane: "cnp", text: "Still there?" });
  const second = await h.waitForCall(1, ENV_AGENT, WAIT_MS);
  assert.match(second.map((turn) => turn.text).join("\n"), /Still there\?/);
  assert.deepEqual(h.callsOf("mate"), [], "a call came from a mate without the environment");
});
