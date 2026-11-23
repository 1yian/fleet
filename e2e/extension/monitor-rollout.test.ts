import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { git, landOnRemote, tip } from "../support/remote.ts";
import { LiveFleet, until } from "../support/live-fleet.ts";

let fleet: LiveFleet;
beforeEach(async () => {
  fleet = await LiveFleet.start({ FLEET_MAINTENANCE_WAIT_MS: "25000" }, { restartableCardd: true });
});
afterEach(async (t) => {
  await fleet.lab.printIfFailed(t);
  await fleet.stop();
});

const monitor = (): string =>
  `echo run >> ${fleet.gate("runs")}; touch ${fleet.gate("started")}; while [ ! -f ${fleet.gate("gate")} ]; do sleep 0.1; done; touch ${fleet.gate("finished")}`;

async function carddCommit(): Promise<string | undefined> {
  const response = await fetch(
    fleet.cardd.url.replace(/^ws/, "http").replace(/\/session$/, "/api/version"),
  );
  const body: unknown = await response.json();
  const commit: unknown = Reflect.get(Object(body), "commit");
  return typeof commit === "string" ? commit : undefined;
}

test("a standing monitor does not stop /updatefleet from restarting cardd on the new code, survives the restart, and its worker reloads once the monitor ends", async () => {
  for (let call = 0; call < 60; call += 1)
    fleet.h.onModel((turns) => {
      const at = turns.findLastIndex((turn) => turn.role === "user");
      const launched = turns.slice(at).some((turn) => turn.role === "toolResult");
      const opening = turns.findIndex((turn) => turn.role === "user") === at;
      return opening && !launched
        ? { tool: "run_long", args: { label: "monitor", command: monitor() } }
        : { text: "monitoring" };
    }, "worker");
  fleet.h.onModel(() => ({ text: "noted" }), "mate");
  await fleet.startMain();
  const worker = await fleet.startWorker("monitor", "local");
  await until(() => (existsSync(fleet.gate("started")) ? true : undefined), "the monitor to start");
  const pid = await until(() => fleet.piIn(worker.pane), "the worker to run Pi");
  const old = tip(fleet.here.root);
  assert.equal(await carddCommit(), old);
  fleet.landCode();
  const main = join("packages", "cardd", "src", "main.ts");
  const fresh = landOnRemote(
    fleet.remote,
    "cardd-change",
    main,
    `${readFileSync(join(fleet.here.root, main), "utf8")}\n`,
  );

  await fleet.lab.submit(fleet.mainPane, "/updatefleet");
  const report = await until(
    () => fleet.userTexts("mate").find((text) => text.startsWith("[fleet] update:")),
    "main to record the update's report",
  );
  assert.match(report, /local cardd \(.*restarted and answers on/);
  assert.equal(await carddCommit(), fresh);
  assert.equal(git(fleet.here.root, "rev-parse", "HEAD"), fresh);
  assert.ok(report.includes(`${worker.session} (worker on local): reload pending`));
  assert.equal(existsSync(fleet.gate("finished")), false);
  assert.equal(await fleet.piIn(worker.pane), pid);
  assert.equal(readFileSync(fleet.gate("runs"), "utf8"), "run\n");

  fleet.open("gate");
  await until(() => (existsSync(fleet.gate("finished")) ? true : undefined), "the monitor to end");
  assert.notEqual(await fleet.newPid(worker.pane, pid), pid);
  assert.equal(readFileSync(fleet.gate("runs"), "utf8"), "run\n");
});
