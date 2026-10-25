import assert from "node:assert/strict";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { Cardd, type Session } from "../support/cardd.ts";
import { Harness, type Turn } from "../support/harness.ts";
import { HerdrLab } from "../support/herdr.ts";
import { configureMain, mateArgs, Scratch, startMain } from "../support/scratch.ts";

const WAIT_MS = 60_000;
const BIN = fileURLToPath(new URL("../../node_modules/.bin", import.meta.url));

let cardd: Cardd;
let h: Harness;
let lab: HerdrLab;
let here: Scratch;
let ghost: Session;
beforeEach(async () => {
  cardd = await Cardd.start();
  h = await Harness.start();
  here = new Scratch();
  configureMain(here, cardd.url, cardd.addLane("main", undefined, here.root), {});
  here.addLane("ops", {
    url: cardd.url,
    token: cardd.addLane("ops", "main"),
    args: mateArgs(h),
  });
  ghost = await cardd.connect(cardd.addLane("ghost", "main"));
  const slow = join(h.dir, "slow-gh");
  mkdirSync(slow);
  const gh = join(slow, "gh");
  writeFileSync(
    gh,
    [
      "#!/bin/sh",
      "if [ \"$1\" = --version ]; then echo 'gh version 2.0.0'; exit 0; fi",
      "exec sleep 600",
      "",
    ].join("\n"),
  );
  chmodSync(gh, 0o755);
  lab = await HerdrLab.start({
    ...h.piEnv("mate"),
    PATH: `${slow}:${BIN}:${process.env["PATH"] ?? ""}`,
    FLEET_PROBE_TIMEOUT_MS: "1000",
    FLEET_SUPERVISE_MS: "1000",
  });
});
afterEach(async (t) => {
  await lab.printIfFailed(t);
  const stopped = await Promise.allSettled([ghost.close(), lab.stop(), h.stop(), cardd.stop()]);
  here.dispose();
  const failed = stopped.find((result) => result.status === "rejected");
  if (failed !== undefined) throw new Error(`cleanup failed: ${String(failed.reason)}`);
});

async function until<T>(read: () => Promise<T | undefined>, what: string): Promise<T> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

const users = (turns: Turn[]): string =>
  turns
    .filter((turn) => turn.role === "user")
    .map((turn) => turn.text)
    .join("\n");

test("a gh that never answers does not make main report the host failed while it brings lanes up", async () => {
  h.onModel(() => ({ text: "noted" }), "mate");
  const pane = await startMain(lab, here, h);
  await until(async () => {
    const screen = await lab.screen(pane);
    return /ops started on local|local failed/.test(screen) ? true : undefined;
  }, "main to report the first lane pass");
  const card: unknown = await ghost.call("card.new", { title: "Wake main", kind: "scout" });
  const id: unknown = Reflect.get(Object(card), "id");
  await ghost.call("hold", {
    card: id,
    question: "Wake main?",
    options: ["Yes"],
  });
  const turns = await h.waitForCall(0, "mate", WAIT_MS);
  const said = users(turns);
  assert.match(said, /\[fleet\] lanes: ops started on local/);
  assert.doesNotMatch(said, /failed|could not check gh login/);
});
