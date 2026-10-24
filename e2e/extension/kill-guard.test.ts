import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { begin, newCard, startFleet, type Fleet } from "../support/fleet.ts";
import { spawnGuarded } from "../support/guarded.ts";
import { Harness, type Turn } from "../support/harness.ts";

const EXTENSION = fileURLToPath(new URL("../../packages/extension/src/index.ts", import.meta.url));
const REFUSED =
  /refused: pkill, killall, and kill fed by pgrep, pidof, or ps signal every matching process/;

let fleet: Fleet;
let h: Harness;
let bystander: ChildProcess;
let marker: string;

beforeEach(async () => {
  fleet = await startFleet();
  h = await Harness.start();
  marker = `fleet-kill-guard-${randomBytes(6).toString("hex")}`;
  bystander = spawnGuarded("node", ["-e", "setInterval(() => {}, 1000)", marker], {
    stdio: "ignore",
  });
});
afterEach(async () => {
  bystander.kill("SIGKILL");
  const stopped = await Promise.allSettled([h.stop(), fleet.cardd.stop()]);
  const failed = stopped.find((result) => result.status === "rejected");
  if (failed !== undefined) throw new Error(`cleanup failed: ${String(failed.reason)}`);
});

const alive = (child: ChildProcess): boolean =>
  child.exitCode === null && child.signalCode === null;
const lastText = (turns: Turn[] | undefined): string => turns?.at(-1)?.text ?? "";

test("a worker is refused a kill by name or pattern, so another run's process on the host survives, and it can still signal its own PID", async () => {
  const attempts = [
    `pkill -f "${marker}"`,
    `killall -r "${marker}"`,
    `if pgrep -f ${marker} >/dev/null; then pkill -f ${marker}; fi`,
    `out="$(pkill -f ${marker})"; echo "$out"`,
    `"pkill" -f ${marker}`,
    `env pkill -f ${marker}`,
    `kill $(pgrep -f "${marker}")`,
    `pgrep -f ${marker} | xargs -I{} kill {}`,
    `ps -eo pid,args | grep "${marker}" | awk '{print $1}' | xargs kill`,
  ];
  for (const command of attempts) h.onModel(() => ({ tool: "bash", args: { command } }));
  h.onModel(() => ({
    tool: "bash",
    args: { command: "printf 'pkill and killall\\n' | grep -c pkill" },
  }));
  let aliveAfterAttempts = false;
  h.onModel(() => {
    aliveAfterAttempts = alive(bystander);
    return { tool: "bash", args: { command: `kill ${String(bystander.pid)}` } };
  });
  h.onModel(() => ({
    tool: "report",
    args: { status: "done", text: "cleaned up my own process" },
  }));
  const card = await newCard(fleet.main, "Clean up a stray process");
  const token = await begin(fleet.main, card, "stop the stray process");
  const exited = new Promise((resolve) => {
    bystander.once("exit", (_code, signal) => {
      resolve(signal);
    });
  });
  h.startPi(
    `c-${String(card.id)}-a1`,
    { FLEET_URL: fleet.cardd.url, FLEET_TOKEN: token, FLEET_ROLE: "worker" },
    [EXTENSION],
    [],
    true,
  );
  await fleet.main.waitForEntries(1);

  for (const [index, command] of attempts.entries())
    assert.match(lastText(h.calls[index + 1]), REFUSED, command);
  assert.match(lastText(h.calls[attempts.length + 1]), /^1\s*$/);
  assert.equal(aliveAfterAttempts, true);
  assert.equal(await exited, "SIGTERM");
});
