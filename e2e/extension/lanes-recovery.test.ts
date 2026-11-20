import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { toolResults } from "../support/dispatch-lab.ts";
import { configureMain, startMain } from "../support/scratch.ts";

import {
  WAIT_MS,
  TRANSPORT,
  TORN,
  cardd,
  h,
  lab,
  here,
  p620,
  marker,
  mainToken,
  until,
  rowsOf,
  states,
  waitState,
  groupOf,
  waitPi,
  sessionText,
  wakeMain,
  users,
} from "../support/lanes-lab.ts";

test("unread transport and nested observations neither report failure nor clear a confirmed outage", async () => {
  const control = join(here.parent, "faults");
  p620.addLane("spare", { url: cardd.url, token: cardd.addLane("spare", "main"), hold: true });
  const faults = [
    "blank",
    "cut",
    "partial",
    "failure-only",
    "down",
    "nested",
    "omit-row",
    "omit-all",
    "duplicate-row",
    "wrong-row",
    "failed",
    "failed-partial",
    "failure-with-start",
    "operation-failure",
    "down",
  ];
  writeFileSync(control, faults.join("\n"));
  configureMain(here, cardd.url, mainToken, {
    hosts: { p620: ["node", TORN, control] },
    roots: { p620: p620.root },
  });
  h.onModel(() => ({ text: "noted" }), "mate");
  await startMain(lab, here, h);
  const turns = await h.waitForCall(0, "mate", WAIT_MS);
  assert.match(users(turns), /\[fleet\] lanes: p620 cannot be reached/);
  await until(
    () => (sessionText().includes("p620 can be reached again") ? true : undefined),
    "main to report the first complete observation after the outage",
  );
  assert.deepEqual(
    readFileSync(`${control}.log`, "utf8")
      .split("\n")
      .slice(0, faults.length + 1),
    [...faults, "whole"],
  );
  const notices = sessionText();
  const outage = "p620 cannot be reached";
  const failure = "p620 failed: could not acquire the next lane's lifecycle lock";
  const recovery = "p620 can be reached again";
  for (const notice of [outage, "far started on p620", failure, recovery])
    assert.equal(notices.split(notice).length - 1, 1, notice);
  assert.ok(notices.indexOf(outage) < notices.indexOf(failure));
  assert.ok(notices.indexOf(failure) < notices.indexOf(recovery));
  assert.doesNotMatch(notices, /obsolete envelope|unconfirmed|p620 could not be read/);
  await waitState(p620, "far", "running");
});

test("a capability probe that ignores SIGTERM is stopped without running a sweep", async () => {
  const control = join(here.parent, "hung-probe");
  writeFileSync(`${control}.capability`, "hang-once");
  configureMain(here, cardd.url, mainToken, {
    hosts: { p620: ["node", TORN, control] },
    roots: { p620: p620.root },
  });
  h.onModel(() => ({ text: "noted" }), "mate");
  await startMain(lab, here, h);
  const turns = await h.waitForCall(0, "mate", WAIT_MS);
  assert.match(users(turns), /could not verify maintenance support on p620: .*stopped/);
  const pid = Number(readFileSync(`${control}.pid`, "utf8"));
  assert.ok(pid > 1);
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  await waitState(p620, "far", "running");
});

test("maintenance waits on ambiguous support and reports a confirmed old host's failure", async () => {
  const control = join(here.parent, "version-faults");
  const capability = `${control}.capability`;
  writeFileSync(control, "legacy-failure\n");
  writeFileSync(capability, "ambiguous");
  configureMain(here, cardd.url, mainToken, {
    hosts: { p620: ["node", TORN, control] },
    roots: { p620: p620.root },
  });
  h.onModel(() => ({ text: "noted" }), "mate");
  await startMain(lab, here, h);
  const blocked = await h.waitForCall(0, "mate", WAIT_MS);
  assert.match(users(blocked), /could not verify maintenance support on p620/);
  assert.equal(states(p620)["far"], "down");
  assert.throws(() => readFileSync(`${control}.log`), { code: "ENOENT" });
  writeFileSync(capability, "legacy");
  await until(
    () =>
      sessionText().includes("legacy maintenance could not acquire the lane lock")
        ? true
        : undefined,
    "main to report the old host's operation failure",
  );
  await waitState(p620, "far", "running");
  const probes = readFileSync(`${control}.probes`, "utf8").trim().split("\n");
  assert.equal(probes[0], "ambiguous");
  assert.ok(probes.includes("legacy"));
  assert.equal(readFileSync(`${control}.log`, "utf8").split("\n")[0], "legacy-failure");
});

test("a mate that keeps dying is held, and only naming it starts it again", async () => {
  const loopy = cardd.addLane("loopy", "main");
  here.addLane("loopy", {
    url: cardd.url,
    token: `-${loopy}`,
    args: ["--approve", "--definitely-not-an-option"],
  });
  const actionOf = (lane: string): unknown =>
    rowsOf(here, ["up"]).find((row) => row["lane"] === lane)?.["action"];
  for (let start = 1; start <= 3; start += 1) {
    assert.equal(actionOf("loopy"), "started");
    await waitState(here, "loopy", "down");
  }
  assert.equal(actionOf("loopy"), "held");
  assert.equal(states(here)["loopy"], "stopped");
  assert.match(here.fleet(["up"], { HERDR_SESSION: lab.name }), /loopy: stopped: crash loop/);
  assert.match(here.fleet(["up", "loopy"], { HERDR_SESSION: lab.name }), /^loopy: started/);
});

test("main stops, restarts, and starts lanes with lane, its board shows them, and it never starts a lane held by hand", async () => {
  let kicked: number | undefined;
  h.onModel(() => ({ tool: "lane", args: { name: "ops", action: "stop" } }), "mate");
  h.onModel(async (turns) => {
    assert.match(toolResults(turns).at(-1) ?? "", /^ops \(local\): stopped$/);
    kicked = await groupOf("far");
    process.kill(-kicked, "SIGKILL");
    await until(async () => ((await groupOf("far")) === kicked ? undefined : true), "far to die");
    await waitState(p620, "far", "running");
    await waitPi("far");
    assert.equal(states(here)["ops"], "stopped");
    return { tool: "board", args: {} };
  }, "mate");
  h.onModel((turns) => {
    const board = toolResults(turns).at(-1) ?? "";
    assert.match(board, /^lanes\[2\]\{name,state\}:\n {2}ops,stopped\n {2}far,running$/m);
    assert.match(board, /^ {2}Call `board\(lanes=true\)` to see why a lane is down or stopped$/m);
    assert.match(
      board,
      /^ {2}Call `lane\(name=<lane>, action="start"\)` to start a lane that is down or stopped$/m,
    );
    return { tool: "board", args: { lanes: true } };
  }, "mate");
  h.onModel((turns) => {
    const board = toolResults(turns).at(-1) ?? "";
    assert.match(board, /^ {2}ops,local,stopped,stopped by hand$/m);
    assert.match(board, /^lanes\[2\]\{name,host,state,detail\}:$/m);
    assert.match(board, /^ {2}far,p620,running,""$/m);
    assert.doesNotMatch(board, /board\(lanes=true\)/);
    return { tool: "lane", args: { name: "all", action: "stop" } };
  }, "mate");
  h.onModel((turns) => {
    assert.equal(
      toolResults(turns).at(-1),
      'lane "all" only restarts: name each lane to start or stop it',
    );
    return { tool: "lane", args: { name: "all", action: "restart" } };
  }, "mate");
  h.onModel((turns) => {
    const restart = toolResults(turns).at(-1) ?? "";
    assert.match(restart, /far \(p620\): started/);
    assert.match(restart, /ops \(local\): stopped - stopped by hand/);
    return { tool: "lane", args: { name: "ops", action: "start" } };
  }, "mate");
  h.onModel(() => ({ text: "all lanes run" }), "mate");
  await startMain(lab, here, h);
  await waitState(here, "ops", "running");
  await waitState(p620, "far", "running");
  await wakeMain("Check the lanes");
  const turns = await h.waitForCall(6, "mate", WAIT_MS);
  assert.match(
    turns.filter((turn) => turn.role === "toolResult").at(-1)?.text ?? "",
    /^ops \(local\): started$/,
  );
  await waitState(here, "ops", "running");
});

test("a host whose transport hangs delays no lane on another host when main starts or when a lane dies", async () => {
  const hung = join(here.parent, "slow-hung");
  writeFileSync(hung, "hang");
  configureMain(here, cardd.url, mainToken, {
    hosts: { slow: ["node", TRANSPORT, hung], p620: ["node", TRANSPORT, marker] },
    roots: { p620: p620.root },
  });
  h.onModel(() => ({ text: "noted" }), "mate");
  await startMain(lab, here, h);
  await waitState(here, "ops", "running");
  await waitState(p620, "far", "running");

  const before = await groupOf("far");
  process.kill(-before, "SIGKILL");
  await until(
    async () => ((await groupOf("far")) === before ? undefined : true),
    "far to leave its old Pi",
  );
  await waitState(p620, "far", "running");
  assert.notEqual(await groupOf("far"), before);
});
