import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import type { Session } from "../support/cardd.ts";
import { begin, newCard, startFleet, type Fleet } from "../support/fleet.ts";
import { configureMain, Scratch } from "../support/scratch.ts";

let fleet: Fleet;
let scratch: Scratch;
let cleo: Session;
beforeEach(async () => {
  fleet = await startFleet();
  scratch = new Scratch();
  configureMain(scratch, fleet.cardd.url, fleet.mainToken);
  cleo = await fleet.cardd.connect(fleet.cardd.addLane("cleo", "main"));
});
afterEach(async () => {
  await cleo.close();
  scratch.dispose();
  await fleet.cardd.stop();
});

const refusal = async (attempt: Promise<unknown>): Promise<string> =>
  attempt.then(
    () => assert.fail("it was not refused"),
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );

test("fleet pause starts no new worker and sends no wake until fleet resume", async () => {
  const paused = scratch.fleet(["pause", "Claude is out until six"]);
  assert.match(
    paused,
    /^fleet: paused since \S+ by main: Claude is out until six\. No new worker starts and no wake is sent until fleet resume\.\n$/,
  );

  const card = await newCard(fleet.main, "Users see one scrollbar");
  assert.match(
    await refusal(begin(fleet.main, card)),
    /^the fleet is paused since \S+ by main: Claude is out until six\. No new worker until the captain runs fleet resume\.$/,
  );
  assert.match(
    await refusal(cleo.call("wake", { note: "check the ads", script: "hourly" })),
    /^the fleet is paused since .* No wake until the captain runs fleet resume\.$/,
  );

  assert.equal(scratch.fleet(["resume"]), "fleet: resumed\n");
  assert.equal(scratch.fleet(["resume"]), "fleet: was not paused\n");
  assert.ok((await begin(fleet.main, card)).length > 0);
  assert.ok(await cleo.call("wake", { note: "check the ads", script: "hourly" }));
});
