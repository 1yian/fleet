import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { Cardd } from "../support/cardd.ts";
import { toolResults } from "../support/dispatch-lab.ts";
import { Harness } from "../support/harness.ts";
import { HerdrLab } from "../support/herdr.ts";
import { cloneWithRemote, landOnRemote, tip } from "../support/remote.ts";
import { mateArgs, Scratch } from "../support/scratch.ts";
import { tempDir } from "../support/run-root.ts";

const WAIT_MS = 60_000;
const BIN = fileURLToPath(new URL("../../node_modules/.bin", import.meta.url));
const PROBE = fileURLToPath(new URL("../support/probe.ts", import.meta.url));
const OTHER_HOSTS_PATH = "/not/a/folder/on/this/host/fleet";

let cardd: Cardd;
let h: Harness;
let lab: HerdrLab;
let scratch: Scratch;
let dir: string;
beforeEach(async () => {
  cardd = await Cardd.start();
  h = await Harness.start();
  scratch = new Scratch();
  dir = tempDir("fleet-hosts-");
  lab = await HerdrLab.start({
    ...h.piEnv("mate"),
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

async function closeInSecondMatesLane(
  clones: Record<string, string>,
  settings: { host?: string },
): Promise<string> {
  const mainToken = cardd.addLane("main");
  const fleetToken = cardd.addLane("fleet", "main");
  scratch.addLane("fleet", {
    url: cardd.url,
    token: fleetToken,
    args: [...mateArgs(h), "-e", PROBE],
    ...settings,
  });
  cardd.addProject("fleet", clones, "acme/fleet");
  const main = await cardd.connect(mainToken);
  const lane = await cardd.connect(fleetToken);
  await lane.call("card.new", {
    title: "Fix the sidebar",
    name: "fix-sidebar",
    kind: "ship",
    project: "fleet",
  });
  await lane.close();
  h.onModel(
    () => ({ tool: "close", args: { card: 2, summary: "not needed", landed: false } }),
    "mate",
  );
  h.onModel(() => ({ text: "closed" }), "mate");

  scratch.fleet(["up", "fleet"], { HERDR_SESSION: lab.name });
  await h.waitFor((event) => event["type"] === "fleet_connected", "the mate to join the fleet");
  await main.call("comment", { lane: "fleet", text: "Close it." });
  const results = toolResults(await h.waitForCall(1, "mate", WAIT_MS));
  await main.close();
  return results.at(-1) ?? "";
}

test("a second mate's close never refreshes another host's clone on its own host: it names the host it has no transport for", async () => {
  const here = cloneWithRemote(dir, "here");
  const before = tip(here.clone);
  const ahead = landOnRemote(here.remote, "merged-pr");
  const result = await closeInSecondMatesLane(
    { local: here.clone, elsewhere: OTHER_HOSTS_PATH },
    {},
  );

  assert.match(result, /^c-2 is dropped\. Clones: /);
  assert.match(
    result,
    new RegExp(`fleet on local: synced ${before.slice(0, 7)}\\.\\.${ahead.slice(0, 7)}`),
  );
  assert.match(result, /fleet on elsewhere: skipped: no transport for elsewhere/);
  assert.doesNotMatch(result, /not a directory/);
  assert.equal(tip(here.clone), ahead);
});

test("a second mate that names its own host refreshes that host's clone here, and still has no transport for another", async () => {
  const here = cloneWithRemote(dir, "here");
  const ahead = landOnRemote(here.remote, "merged-pr");
  const result = await closeInSecondMatesLane(
    { p620: here.clone, elsewhere: OTHER_HOSTS_PATH },
    { host: "p620" },
  );

  assert.match(result, /fleet on p620: synced /);
  assert.match(result, /fleet on elsewhere: skipped: no transport for elsewhere/);
  assert.equal(tip(here.clone), ahead);
});
