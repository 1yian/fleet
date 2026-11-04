import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { LiveFleet, until } from "../support/live-fleet.ts";
import { records } from "../support/json.ts";

let fleet: LiveFleet;
beforeEach(async () => {
  fleet = await LiveFleet.start({ FLEET_MAINTENANCE_WAIT_MS: "25000" });
});
afterEach(async (t) => {
  await fleet.lab.printIfFailed(t);
  await fleet.stop();
});

async function labels(): Promise<Map<string, string>> {
  const spaces = records((await fleet.lab.run(["workspace", "list"]))["workspaces"]);
  return new Map(spaces.map((each) => [String(each["workspace_id"]), String(each["label"])]));
}

async function panesOf(workspace: string): Promise<string[]> {
  const listed = await fleet.lab.run(["pane", "list", "--workspace", workspace]);
  return records(listed["panes"]).map((each) => String(each["pane_id"]));
}

async function workspaceLabelled(label: string): Promise<string> {
  const found = [...(await labels())].find(([, each]) => each === label);
  assert.ok(found !== undefined, `no workspace is labelled ${label}`);
  return found[0];
}

async function updateFleet(): Promise<void> {
  fleet.landCode();
  await fleet.lab.submit(fleet.mainPane, "/updatefleet");
  await until(
    () => fleet.userTexts("mate").find((text) => text.startsWith("[fleet] update:")),
    "main to record the update's report",
  );
}

test("a second mate's workspace that a stray run renamed 1stmate is not duplicated by the keeper, and /updatefleet gives it back its name in the same pane", async () => {
  await fleet.startMain();
  const was = await fleet.matePid("ops");
  await fleet.matePid("far");
  const ops = await workspaceLabelled("2ndmate-ops");
  const panes = await panesOf(ops);
  await fleet.lab.run(["workspace", "rename", ops, "1stmate"]);

  const kept = fleet.here.fleet(["up"], { HERDR_SESSION: fleet.lab.name });
  assert.equal(kept, "ops: already running in 2ndmate-ops\n");
  assert.deepEqual([...(await labels()).values()].sort(), ["1stmate", "1stmate", "2ndmate-far"]);

  await updateFleet();

  await fleet.newPid(panes[0] ?? "", was);
  const seen = await until(async () => {
    const now = await labels();
    return now.get(ops) === "2ndmate-ops" ? now : undefined;
  }, "the workspace to read 2ndmate-ops again");
  assert.deepEqual([...seen.values()].sort(), ["1stmate", "2ndmate-far", "2ndmate-ops"]);
  assert.deepEqual(await panesOf(ops), panes);
});

test("a worker's workspace that a stray run renamed 1stmate gets its card's name back on /updatefleet, and main keeps the only 1stmate", async () => {
  await fleet.startMain();
  await fleet.matePid("ops");
  await fleet.matePid("far");
  const worker = await fleet.startWorker("paused", "local");
  await until(() => fleet.piIn(worker.pane), `${worker.session} to run Pi`);
  const workspace = await workspaceLabelled(worker.session);
  const main = await workspaceLabelled("1stmate");
  await fleet.lab.run(["workspace", "rename", workspace, "1stmate"]);

  await updateFleet();

  const name = (await fleet.cardOf(worker.card)).name;
  const seen = await until(async () => {
    const now = await labels();
    return now.get(workspace) === name ? now : undefined;
  }, `the worker's workspace to read ${name}`);
  assert.equal(seen.get(main), "1stmate");
  assert.deepEqual(await panesOf(workspace), [worker.pane]);
});
