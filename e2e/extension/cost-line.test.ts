import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { OPS_TURNS, QUIET_TURNS, writeLedger } from "../support/ledger.ts";
import { Scratch } from "../support/scratch.ts";
import { configureMain } from "../support/scratch.ts";

let here: Scratch;
beforeEach(() => {
  here = new Scratch();
  configureMain(here, "ws://127.0.0.1:1/session", "token");
  here.addLane("ops", { url: "ws://127.0.0.1:1/session", token: "t1" });
  here.addLane("quiet", { url: "ws://127.0.0.1:1/session", token: "t2" });
  writeLedger(`${here.root}.worktrees/lane-ops`, OPS_TURNS);
  writeLedger(`${here.root}.worktrees/lane-quiet`, QUIET_TURNS);
});
afterEach(() => {
  here.dispose();
});

test("fleet cost prints one line per mate: dollars for 24 hours, input as a share of full price, and cold starts", () => {
  assert.deepEqual(here.fleet(["cost"]).trim().split("\n"), [
    "ops: $1.60 in 24h, input at 68.5% of full price, cold starts: 1",
    "quiet: $0.11 in 24h, input at 10.9% of full price, cold starts: 0",
  ]);
});
