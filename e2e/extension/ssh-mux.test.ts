import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { Cardd, type Session } from "../support/cardd.ts";
import { Harness, type Turn } from "../support/harness.ts";
import { HerdrLab } from "../support/herdr.ts";
import { MuxSsh, type SshCall } from "../support/mux-ssh.ts";
import { cloneWithRemote, landOnRemote, tip } from "../support/remote.ts";
import { configureMain, mateArgs, Scratch, startMain } from "../support/scratch.ts";

const WAIT_MS = 60_000;
const BIN = fileURLToPath(new URL("../../node_modules/.bin", import.meta.url));

let cardd: Cardd;
let h: Harness;
let lab: HerdrLab;
let here: Scratch;
let p620: Scratch;
let ssh: MuxSsh;
let ghost: Session;
beforeEach(async () => {
  cardd = await Cardd.start();
  h = await Harness.start();
  here = new Scratch();
  p620 = new Scratch();
  ssh = new MuxSsh();
  const mainToken = cardd.addLane("main", undefined, here.root);
  configureMain(here, cardd.url, mainToken, {
    hosts: { p620: ["ssh", "p620"] },
    roots: { p620: p620.root },
  });
  p620.addLane("far", {
    url: cardd.url,
    token: cardd.addLane("far", "main"),
    args: mateArgs(h),
  });
  ghost = await cardd.connect(cardd.addLane("ghost", "main"));
  lab = await HerdrLab.start({
    ...h.piEnv("mate"),
    PATH: `${ssh.bin}:${BIN}:${process.env["PATH"] ?? ""}`,
    FLEET_SUPERVISE_MS: "1000",
  });
});
afterEach(async (t) => {
  await lab.printIfFailed(t);
  const stopped = await Promise.allSettled([ghost.close(), lab.stop(), h.stop(), cardd.stop()]);
  here.dispose();
  p620.dispose();
  const failed = stopped.find((result) => result.status === "rejected");
  if (failed !== undefined) throw new Error(`cleanup failed: ${String(failed.reason)}`);
});

const users = (turns: Turn[]): string =>
  turns
    .filter((turn) => turn.role === "user")
    .map((turn) => turn.text)
    .join("\n");

async function wakeMain(title: string): Promise<void> {
  const card: unknown = await ghost.call("card.new", { title, kind: "scout" });
  const id: unknown = Reflect.get(Object(card), "id");
  await ghost.call("hold", { card: id, question: `${title}?`, options: ["Yes"] });
}

async function until<T>(read: () => T | undefined | Promise<T | undefined>, what: string) {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

async function mainHears(pane: string): Promise<string> {
  await until(async () => {
    const screen = await lab.screen(pane);
    return screen.includes("[fleet] lanes: ") && screen.includes("clones: site on p620: ")
      ? true
      : undefined;
  }, "main to show the lane check and the clone report");
  await wakeMain("Ship the scrollbar fix");
  return until(
    () =>
      h
        .callsOf("mate")
        .map(users)
        .find((text) => /^\[fleet\] lanes: /m.test(text) && /^\[fleet\] clones: /m.test(text)),
    "the mate to be told about both",
  );
}

const perCommand = (calls: readonly SshCall[], direct: boolean): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const call of calls.filter((each) => each.direct === direct))
    counts.set(call.command, (counts.get(call.command) ?? 0) + 1);
  return counts;
};

async function startMainWith(
  mode: "wedged" | "wedged-down" | "down",
): Promise<{ heard: string; site: string; fresh: string }> {
  const site = cloneWithRemote(here.parent, "site");
  const fresh = landOnRemote(site.remote, "merged-pr");
  cardd.addProject("site", { p620: site.clone });
  ssh.mode = mode;
  h.onModel(() => ({ text: "noted" }), "mate");
  const pane = await startMain(lab, here, h);
  return { heard: await mainHears(pane), site: site.clone, fresh };
}

test("a lane check and a clone refresh recover when the ssh master refuses to pass file descriptors: each retries once without the master", async () => {
  const { heard, site, fresh } = await startMainWith("wedged");

  assert.match(heard, /\[fleet\] lanes: far started on p620/);
  assert.match(heard, /\[fleet\] clones: site on p620: synced [0-9a-f]+\.\.[0-9a-f]+/);
  assert.doesNotMatch(heard, /cannot be reached|refresh failed|Message too long/);
  assert.equal(tip(site), fresh);

  const calls = ssh.calls();
  const direct = calls.filter((call) => call.direct);
  assert.ok(
    direct.some((call) => call.command.includes("refresh_clone")),
    "the clone refresh was retried without the master",
  );
  assert.ok(
    direct.some((call) => call.command.includes("'up' '--maintenance'")),
    "the lane check was retried without the master",
  );
  const refused = perCommand(calls, false);
  for (const [command, retries] of perCommand(calls, true))
    assert.ok(
      retries <= (refused.get(command) ?? 0),
      "a refused attempt is retried once, and a command that was not refused is not retried",
    );
});

test("a host that cannot be reached is still reported unreachable, with the reason from the retry, after a refused master", async () => {
  const { heard, site, fresh } = await startMainWith("wedged-down");

  assert.match(heard, /\[fleet\] lanes: p620 cannot be reached: .*Operation timed out/);
  assert.match(heard, /\[fleet\] clones: site on p620: cannot be reached: .*Operation timed out/);
  assert.doesNotMatch(heard, /Message too long|synced|started on p620/);
  assert.notEqual(tip(site), fresh);
  assert.ok(
    ssh.calls().some((call) => call.direct),
    "the retry without the master was made",
  );
});

test("a host that cannot be reached with no master involved is reported at once, with no retry", async () => {
  const { heard, site, fresh } = await startMainWith("down");

  assert.match(heard, /\[fleet\] lanes: p620 cannot be reached: .*Operation timed out/);
  assert.match(heard, /\[fleet\] clones: site on p620: cannot be reached: .*Operation timed out/);
  assert.notEqual(tip(site), fresh);
  const calls = ssh.calls();
  assert.ok(calls.length > 0);
  assert.deepEqual(
    calls.filter((call) => call.direct),
    [],
  );
});
