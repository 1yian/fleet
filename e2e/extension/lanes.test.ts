import assert from "node:assert/strict";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { records } from "../support/json.ts";
import { OPS_TURNS, QUIET_TURNS, writeLedger } from "../support/ledger.ts";
import { cloneWithRemote, landOnRemote, tip } from "../support/remote.ts";
import { mateArgs, startMain } from "../support/scratch.ts";

import {
  WAIT_MS,
  cardd,
  h,
  lab,
  here,
  p620,
  marker,
  until,
  rowsOf,
  waitState,
  paneInfo,
  groupOf,
  waitPi,
  sessionText,
  wakeMain,
  users,
} from "../support/lanes-lab.ts";

test(
  "a mate starts with its compile cache under the host's fleet folder, off the tmp folder",
  { skip: process.platform !== "linux" && "reads /proc" },
  async () => {
    h.onModel(() => ({ text: "noted" }), "mate");
    await startMain(lab, here, h);
    await waitState(here, "ops", "running");
    await waitPi("ops");
    const processes = records((await paneInfo("ops"))[0]?.["foreground_processes"]);
    const pid = processes.find((each) => each["name"] === "pi" || each["argv0"] === "pi")?.["pid"];
    const environ = readFileSync(`/proc/${String(pid)}/environ`, "utf8").split("\0");
    const hostDir = process.env["FLEET_HOST_DIR"] ?? "";
    assert.notEqual(hostDir, "");
    assert.ok(environ.includes(`NODE_COMPILE_CACHE=${join(hostDir, "node-compile-cache")}`));
  },
);

test("main brings up every lane on both hosts, and starts a mate that dies", async () => {
  h.onModel(() => ({ text: "noted" }), "mate");
  const pane = await startMain(lab, here, h);
  await waitState(here, "ops", "running");
  await waitState(p620, "far", "running");

  await until(async () => {
    const screen = await lab.screen(pane);
    return screen.includes("far started on p620") && screen.includes("ops started on local")
      ? true
      : undefined;
  }, "main to say what it started");
  await wakeMain("Ship the scrollbar fix");
  const turns = await h.waitForCall(0, "mate", WAIT_MS);
  assert.match(users(turns), /\[fleet\] lanes: ops started on local/);
  assert.match(users(turns), /\[fleet\] lanes: far started on p620/);

  const before = await groupOf("far");
  process.kill(-before, "SIGKILL");
  await until(
    async () => ((await groupOf("far")) === before ? undefined : true),
    "far to leave its old Pi",
  );
  await waitState(p620, "far", "running");
  assert.notEqual(await groupOf("far"), before);
});

test("main hears one cost line per mate in a message", async () => {
  here.addLane("quiet", {
    url: cardd.url,
    token: cardd.addLane("quiet", "main"),
    args: mateArgs(h),
  });
  writeLedger(`${here.root}.worktrees/lane-ops`, OPS_TURNS);
  writeLedger(`${here.root}.worktrees/lane-quiet`, QUIET_TURNS);
  h.onModel(() => ({ text: "noted" }), "mate");
  await startMain(lab, here, h);
  const turns = await h.waitForCall(0, "mate", WAIT_MS);
  assert.match(
    users(turns),
    /\[fleet\] cost, last 24 hours:\nops: \$1\.60 in 24h, input at 68\.5% of full price, cold starts: 1\nquiet: \$0\.11 in 24h, input at 10\.9% of full price, cold starts: 0/,
  );
});

test("main refreshes every project clone when it starts: a clean one fast-forwards, and a dirty one is left alone and reported", async () => {
  const site = cloneWithRemote(here.parent, "site");
  const app = cloneWithRemote(here.parent, "app");
  const fresh = landOnRemote(site.remote, "merged-pr");
  landOnRemote(app.remote, "merged-pr");
  const appBefore = tip(app.clone);
  writeFileSync(join(app.clone, "README"), "the captain's edit\n");
  cardd.addProject("site", { local: site.clone });
  cardd.addProject("app", { local: app.clone });
  h.onModel(() => ({ text: "noted" }), "mate");
  await startMain(lab, here, h);

  const turns = await h.waitForCall(0, "mate", WAIT_MS);
  assert.match(
    users(turns),
    /\[fleet\] clones: app on local: STUCK: on branch main with uncommitted changes, 1 commits behind origin\/main - needs attention; site on local: synced [0-9a-f]+\.\.[0-9a-f]+$/m,
  );
  assert.equal(tip(site.clone), fresh);
  assert.equal(tip(app.clone), appBefore);
  assert.equal(readFileSync(join(app.clone, "README"), "utf8"), "the captain's edit\n");
});

test("main hears that a clone level with origin is up to date, with its uncommitted files left alone, and is not woken for it", async () => {
  const site = cloneWithRemote(here.parent, "site");
  writeFileSync(join(site.clone, "README"), "the captain's edit\n");
  writeFileSync(join(site.clone, "notes.txt"), "scratch\n");
  const before = tip(site.clone);
  cardd.addProject("site", { local: site.clone });
  h.onModel(() => ({ text: "noted" }), "mate");
  const pane = await startMain(lab, here, h);

  const screen = await until(async () => {
    const shown = await lab.screen(pane);
    return shown.includes("clones: site on local: ") ? shown : undefined;
  }, "main to show the clone report");
  assert.match(screen, /clones: site on local: up to date, uncommitted files left alone/);
  assert.equal(h.callsOf("mate").length, 0);
  await wakeMain("Drop the old banner");
  const turns = await h.waitForCall(0, "mate", WAIT_MS);
  assert.match(
    users(turns),
    /\[fleet\] clones: site on local: up to date, uncommitted files left alone$/m,
  );
  assert.match(users(turns), /\(hold\): Drop the old banner\?/);
  assert.doesNotMatch(users(turns), /STUCK/);
  assert.equal(tip(site.clone), before);
  assert.equal(readFileSync(join(site.clone, "README"), "utf8"), "the captain's edit\n");
  assert.equal(readFileSync(join(site.clone, "notes.txt"), "utf8"), "scratch\n");
});

test("main tells the captain when a host cannot be reached, and when it is back", async () => {
  h.onModel(() => ({ text: "noted" }), "mate");
  await startMain(lab, here, h);
  await waitState(p620, "far", "running");
  writeFileSync(marker, "down");
  const turns = await h.waitForCall(0, "mate", WAIT_MS);
  assert.match(users(turns), /\[fleet\] lanes: p620 cannot be reached/);

  rmSync(marker);
  await until(
    () => (sessionText().includes("p620 can be reached again") ? true : undefined),
    "main to learn p620 is back",
  );
  await wakeMain("Drop the old banner");
  const next = await h.waitForCall(1, "mate", WAIT_MS);
  assert.match(users(next), /\[fleet\] lanes: p620 can be reached again/);
});

test("an unreadable main preference file never removes a healthy sibling's published copy while another lane is unreadable", async () => {
  const worktrees = `${p620.root}.worktrees`;
  p620.addLane("near", {
    url: cardd.url,
    token: cardd.addLane("near", "main"),
    args: mateArgs(h),
  });
  const copy = join(worktrees, "lane-near", "data", "captain-shared.md");
  const baseline = join(worktrees, "lane-near", "state", "captain-shared.published");
  mkdirSync(join(worktrees, "lane-near", "state"), { recursive: true });
  writeFileSync(copy, "- published\n");
  writeFileSync(baseline, "- published\n");
  writeFileSync(join(worktrees, "lane-far", "config", "lane.json"), "");
  const source = join(here.root, "data", "captain-shared.md");
  rmSync(source, { force: true });
  mkdirSync(source, { recursive: true });
  h.onModel(() => ({ text: "noted" }), "mate");
  await startMain(lab, here, h);
  const heard = (): string => {
    try {
      return sessionText();
    } catch {
      return "";
    }
  };
  await until(
    () => (heard().includes("shared preferences did not reach p620") ? true : undefined),
    "main to report that the shared preferences were not published",
  );
  await until(
    () => (heard().includes("near started on p620") ? true : undefined),
    "the healthy sibling to start",
  );
  assert.equal(readFileSync(copy, "utf8"), "- published\n");
  assert.equal(readFileSync(baseline, "utf8"), "- published\n");
});

for (const fault of ["malformed", "unreadable"]) {
  test(`an ${fault === "malformed" ? "invalid" : fault} lane config prevents maintenance recovery until repaired`, async () => {
    const config = join(`${p620.root}.worktrees`, "lane-far", "config", "lane.json");
    const backup = `${config}.backup`;
    p620.addLane("near", {
      url: cardd.url,
      token: cardd.addLane("near", "main"),
      args: mateArgs(h),
    });
    writeFileSync(
      join(`${p620.root}.worktrees`, "lane-near", "data", "captain-shared.md"),
      "local edit\n",
    );
    writeFileSync(marker, "down");
    renameSync(config, backup);
    if (fault === "malformed") writeFileSync(config, "");
    else mkdirSync(config);
    h.onModel(() => ({ text: "noted" }), "mate");
    await startMain(lab, here, h);
    const outage = await h.waitForCall(0, "mate", WAIT_MS);
    assert.match(users(outage), /p620 cannot be reached/);
    rmSync(marker);
    const detail = fault === "malformed" ? "is not valid JSON" : "EISDIR";
    const failed = "[fleet] lanes: p620 failed: lane far could not be read: ";
    const recovered = "p620 can be reached again";
    const started = "far started on p620";
    await until(
      () =>
        h
          .callsOf("mate")
          .map(users)
          .find((message) => message.includes(failed)),
      "main to report a definite prerequisite failure on p620",
      () => h.callsOf("mate").map(users).at(-1) ?? "no model call",
    );
    await until(
      () => (sessionText().includes("near started on p620") ? true : undefined),
      "a healthy sibling lane to start while far is unreadable",
    );
    await until(
      () => (sessionText().includes("edited copy preserved as data/") ? true : undefined),
      "main to hear where near's edited preferences were kept despite far's failure",
    );
    assert.match(sessionText(), /preserved as data\/[^\n]* \(on p620\)/);
    const rows = await until(
      () => {
        const read = rowsOf(p620, ["status"]);
        return read.find((row) => row["lane"] === "near")?.["state"] === "running"
          ? read
          : undefined;
      },
      "near to read running in one complete status",
      () => JSON.stringify(rowsOf(p620, ["status"])),
    );
    assert.equal(rows.find((row) => row["lane"] === "near")?.["state"], "running");
    const unread = rows.find((row) => row["lane"] === "far");
    assert.equal(unread?.["state"], "unknown");
    assert.match(String(unread["reason"]), new RegExp(detail));
    assert.throws(() => rowsOf(p620, ["status", "--placement"]), new RegExp(detail));
    const beforeRepair = sessionText();
    assert.ok(!beforeRepair.includes(recovered));
    assert.ok(!beforeRepair.includes(started));
    rmSync(config, { recursive: true });
    renameSync(backup, config);
    await until(() => {
      const notices = sessionText();
      return notices.includes(recovered) && notices.includes(started) ? true : undefined;
    }, "main to announce recovery and a successful start after repairing the lane config");
    await waitState(p620, "far", "running");
    const notices = sessionText();
    assert.ok(notices.includes(failed) && notices.indexOf(failed) < notices.indexOf(recovered));
  });
}

test("a failure line that mentions a preserved copy is still reported as a failure", async () => {
  const name = "preserved as x";
  p620.addLane(name, { url: cardd.url, token: cardd.addLane(name, "main"), hold: true });
  writeFileSync(join(`${p620.root}.worktrees`, `lane-${name}`, "config", "lane.json"), "");
  h.onModel(() => ({ text: "noted" }), "mate");
  await startMain(lab, here, h);
  await until(
    () =>
      h
        .callsOf("mate")
        .map(users)
        .find((message) => message.includes(`p620 failed: lane ${name} could not be read`)),
    "main to report the unreadable lane as a failure",
    () => h.callsOf("mate").map(users).at(-1) ?? "no model call",
  );
});
