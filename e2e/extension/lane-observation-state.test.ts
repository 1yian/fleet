import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { isRecord, records } from "../support/json.ts";
import {
  lab,
  here,
  bin,
  real,
  addLane,
  faultLog,
  fleet,
  typedMaintenance,
  maintenanceOutcomes,
  maintain,
  workspace,
  action,
  idlePane,
  untilRunning,
} from "../support/lane-observation-lab.ts";

test("a stop marker that lands while a running mate is being sampled is neither cleared nor reported as a definite outcome", async () => {
  const home = `${here.root}.worktrees/lane-ops`;
  assert.deepEqual(maintain(), action("ops", "started"));
  await untilRunning("ops");
  const marker = join(home, "state", "stopped");
  const land = `printf 'stopped by hand\\n' > ${marker}`;
  const reply: unknown = JSON.parse(fleet(typedMaintenance, "stop-lane", land));
  assert.ok(existsSync(`${faultLog()}.stopped`));
  assert.ok(isRecord(reply));
  assert.deepEqual(reply["outcomes"], action("ops", "unread"));
  assert.equal(readFileSync(marker, "utf8"), "stopped by hand\n");
  assert.ok((await workspace("ops")) !== undefined);
});

test("a lane claim that changes while a running mate is being sampled leaves the lane unread with its hold intact", async () => {
  const home = `${here.root}.worktrees/lane-ops`;
  assert.deepEqual(maintain(), action("ops", "started"));
  await untilRunning("ops");
  const marker = join(home, "state", "stopped");
  writeFileSync(marker, "stopped by hand\n");
  const config = join(home, "config", "lane.json");
  const raw: unknown = JSON.parse(readFileSync(config, "utf8"));
  assert.ok(isRecord(raw));
  writeFileSync(`${config}.next`, JSON.stringify({ ...raw, args: ["--changed-while-sampling"] }));
  const reply: unknown = JSON.parse(fleet(typedMaintenance, "swap-memory", config));
  assert.ok(existsSync(`${config}.swapped`));
  assert.ok(isRecord(reply));
  assert.deepEqual(reply["outcomes"], action("ops", "unread"));
  assert.equal(readFileSync(marker, "utf8"), "stopped by hand\n");
  assert.ok((await workspace("ops")) !== undefined);
});

test("a lane config truncated while status or placement reads Herdr is never published as a definite result", async () => {
  const home = `${here.root}.worktrees/lane-ops`;
  assert.deepEqual(maintain(), action("ops", "started"));
  await untilRunning("ops");
  const config = join(home, "config", "lane.json");
  const good = readFileSync(config, "utf8");
  const truncate = () => {
    rmSync(`${config}.swapped`, { force: true });
    writeFileSync(`${config}.next`, "{");
  };
  truncate();
  const rows: unknown = JSON.parse(fleet(["status", "--json"], "swap-memory", config));
  assert.ok(existsSync(`${config}.swapped`));
  assert.equal(records(rows)[0]?.["state"], "unknown");
  assert.match(String(records(rows)[0]?.["reason"]), /claim changed or became ambiguous/);
  writeFileSync(config, good);
  truncate();
  assert.throws(
    () => fleet(["status", "--placement", "--json"], "swap-memory", config),
    /claim changed or became ambiguous/,
  );
  assert.ok(existsSync(`${config}.swapped`));
  writeFileSync(config, good);
  assert.deepEqual(JSON.parse(fleet(["status", "--placement", "--json"])), [
    { lane: "ops", mate: true },
  ]);
});

test("an earlier lane's claim that changes while a later lane is read is unknown in status and refuses placement", () => {
  addLane("zz");
  const home = `${here.root}.worktrees/lane-ops`;
  const config = join(home, "config", "lane.json");
  const good = readFileSync(config, "utf8");
  const race = () => {
    rmSync(`${config}.swapped`, { force: true });
    rmSync(`${faultLog()}.lists`, { force: true });
    writeFileSync(config, good);
    writeFileSync(`${config}.next`, "{");
  };
  race();
  const rows = records(JSON.parse(fleet(["status", "--json"], "swap-later", config)));
  assert.ok(existsSync(`${config}.swapped`));
  assert.equal(rows.find((row) => row["lane"] === "ops")?.["state"], "unknown");
  assert.match(String(rows.find((row) => row["lane"] === "ops")?.["reason"]), /claim changed/);
  assert.equal(rows.find((row) => row["lane"] === "zz")?.["state"], "down");
  race();
  assert.throws(
    () => fleet(["status", "--placement", "--json"], "swap-later", config),
    /ops claim changed or became ambiguous/,
  );
  assert.ok(existsSync(`${config}.swapped`));
});

test("a stop that lands while a later lane is read makes only the stopped lane unknown", async () => {
  assert.deepEqual(maintain(), action("ops", "started"));
  await untilRunning("ops");
  addLane("zz");
  const stop = `${process.execPath} ${here.launch} stop ops`;
  const rows = records(JSON.parse(fleet(["status", "--json"], "run-later", stop)));
  assert.ok(existsSync(`${faultLog()}.ran`));
  assert.equal(rows.find((row) => row["lane"] === "ops")?.["state"], "unknown");
  assert.match(String(rows.find((row) => row["lane"] === "ops")?.["reason"]), /lifecycle state/);
  assert.equal(rows.find((row) => row["lane"] === "zz")?.["state"], "down");
  assert.deepEqual(JSON.parse(fleet(["status", "--placement", "--json"])), [
    { lane: "ops", mate: false },
    { lane: "zz", mate: false },
  ]);
});

test("a stop that lands while a later lane is read refuses placement", async () => {
  assert.deepEqual(maintain(), action("ops", "started"));
  await untilRunning("ops");
  addLane("zz");
  const stop = `${process.execPath} ${here.launch} stop ops`;
  assert.throws(
    () => fleet(["status", "--placement", "--json"], "run-later", stop),
    /ops lifecycle state changed after it was checked/,
  );
  assert.ok(existsSync(`${faultLog()}.ran`));
});

test("lanes that appear while status reads are reported once as unknown beside definite siblings", () => {
  const zz = addLane("zz");
  const worktrees = `${here.root}.worktrees`;
  const make = [
    `mkdir -p ${worktrees}/lane-yy/config ${worktrees}/lane-xx/config`,
    `printf '{' > ${worktrees}/lane-yy/config/lane.json`,
    `sed 's/"zz"/"xx"/' ${zz}/config/lane.json > ${worktrees}/lane-xx/config/lane.json`,
  ].join(" && ");
  const rows = records(JSON.parse(fleet(["status", "--json"], "run-later", make)));
  assert.ok(existsSync(`${faultLog()}.ran`));
  assert.equal(rows.find((row) => row["lane"] === "ops")?.["state"], "down");
  assert.equal(rows.find((row) => row["lane"] === "zz")?.["state"], "down");
  for (const lane of ["yy", "xx"]) {
    assert.equal(rows.filter((row) => row["lane"] === lane).length, 1, lane);
    assert.equal(rows.find((row) => row["lane"] === lane)?.["state"], "unknown", lane);
  }
  assert.throws(() => fleet(["status", "--placement", "--json"]), /lane yy could not be read/);
});

test("an unreadable lane config is reported safely while healthy lanes still converge and start", async () => {
  addLane("zz");
  const ops = `${here.root}.worktrees/lane-ops`;
  const sentinel = "ZSENTINELTOKENZ";
  writeFileSync(
    `${here.root}.worktrees/lane-zz/config/lane.json`,
    `{"lane":"zz","token": ${sentinel}}`,
  );
  writeFileSync(join(ops, "data", "captain-shared.md"), "local edit\n");
  const content = Buffer.from("- shared\n").toString("base64");
  assert.throws(
    () => fleet(["shared", "--content", content]),
    (error: unknown) => {
      const stdout = String(Reflect.get(Object(error), "stdout"));
      const stderr = String(Reflect.get(Object(error), "stderr"));
      assert.match(stdout, /ops: shared preferences updated, edited copy preserved as data\//);
      assert.match(stderr, /lane zz could not be read: \S+lane\.json is not valid JSON/);
      assert.match(stderr, /ops: shared preferences updated, edited copy preserved as data\//);
      assert.ok(!stdout.includes(sentinel) && !stderr.includes(sentinel));
      return true;
    },
  );
  assert.equal(readFileSync(join(ops, "data", "captain-shared.md"), "utf8"), "- shared\n");
  const reply = maintain();
  assert.ok(isRecord(reply));
  assert.deepEqual(reply["expected"], ["ops", "zz"]);
  assert.deepEqual(reply["outcomes"], action("ops", "started"));
  assert.match(
    String(reply["failed"]),
    /^lane zz could not be read: \S+lane\.json is not valid JSON$/,
  );
  const status = records(JSON.parse(fleet(["status", "--json"])));
  assert.deepEqual(status[0], { lane: "ops", state: "running" });
  assert.equal(status[1]?.["state"], "unknown");
  assert.match(String(status[1]["reason"]), /lane\.json is not valid JSON$/);
  assert.ok(!JSON.stringify(status).includes(sentinel));
  assert.throws(() => fleet(["status", "--placement", "--json"]), /lane zz could not be read/);
  const before = (await workspace("ops"))?.["workspace_id"];
  assert.throws(() => fleet(["restart"]), /lane zz could not be read/);
  assert.equal((await workspace("ops"))?.["workspace_id"], before);
});

test("an unreadable stop marker or start history is unknown and never authorizes a start", async () => {
  const home = `${here.root}.worktrees/lane-ops`;
  await idlePane("ops", home);
  const stopped = join(home, "state", "stopped");
  const starts = join(home, "state", "starts");
  mkdirSync(stopped);
  assert.deepEqual(maintain(), action("ops", "unread"));
  assert.equal(existsSync(starts), false);
  const status = records(JSON.parse(fleet(["status", "--json"])));
  assert.equal(status[0]?.["state"], "unknown");
  assert.match(String(status[0]["reason"]), /could not read state\/stopped \(EISDIR\)/);
  rmSync(stopped, { recursive: true });
  mkdirSync(starts);
  assert.deepEqual(maintain(), action("ops", "unread"));
  assert.equal(existsSync(stopped), false);
  rmSync(starts, { recursive: true });
  assert.deepEqual(maintain(), action("ops", "started"));
});

test("a later preference write failure does not hide an earlier confirmed aside", () => {
  addLane("zz");
  const ops = `${here.root}.worktrees/lane-ops`;
  const zz = `${here.root}.worktrees/lane-zz`;
  writeFileSync(join(ops, "data", "captain-shared.md"), "local edit\n");
  rmSync(join(zz, "data"), { recursive: true });
  writeFileSync(join(zz, "data"), "");
  const content = Buffer.from("- shared\n").toString("base64");
  assert.throws(
    () => fleet(["shared", "--content", content]),
    (error: unknown) => {
      const stderr = String(Reflect.get(Object(error), "stderr"));
      assert.match(stderr, /lane zz could not be updated/);
      assert.match(
        stderr,
        /^fleet-preserved: ops: shared preferences updated, edited copy preserved as data\//m,
      );
      return true;
    },
  );
  assert.equal(readFileSync(join(ops, "data", "captain-shared.md"), "utf8"), "- shared\n");
});

test("a hold with unread start history neither starts, closes, nor lifts anything", async () => {
  const home = `${here.root}.worktrees/lane-ops`;
  await idlePane("ops", home);
  const before = (await workspace("ops"))?.["workspace_id"];
  const stopped = join(home, "state", "stopped");
  writeFileSync(stopped, "held by operator\n");
  mkdirSync(join(home, "state", "starts"));
  for (const args of [["up", "ops", "--json"], ["restart", "ops"], ["restart"], ["stop", "ops"]]) {
    assert.throws(() => fleet(args), /could not read state\/starts \(EISDIR\)/);
    assert.equal(readFileSync(stopped, "utf8"), "held by operator\n", args.join(" "));
    assert.equal((await workspace("ops"))?.["workspace_id"], before, args.join(" "));
  }
  assert.deepEqual(maintain(), action("ops", "unread"));
  assert.equal(readFileSync(stopped, "utf8"), "held by operator\n");
});

test("a torn start history is unread and never authorizes another launch", async () => {
  const home = `${here.root}.worktrees/lane-ops`;
  await idlePane("ops", home);
  const starts = join(home, "state", "starts");
  const now = String(Date.now());
  const stopped = join(home, "state", "stopped");
  const torn = `${now}\n${now}\n${now.slice(0, 7)}`;
  for (const unreadable of ["", torn]) {
    writeFileSync(starts, unreadable);
    assert.deepEqual(maintain(), action("ops", "unread"));
    assert.equal(readFileSync(starts, "utf8"), unreadable);
    assert.equal(existsSync(stopped), false);
    assert.throws(() => fleet(["stop", "ops"]), /state\/starts is incomplete/);
    assert.equal(existsSync(stopped), false);
  }
  writeFileSync(starts, `${now}\n${now}\n${now}\n`);
  assert.deepEqual(maintain(), [
    { lane: "ops", action: "held", detail: "started 3 times in 10 minutes" },
  ]);
  rmSync(starts);
  rmSync(stopped);
  assert.deepEqual(maintain(), action("ops", "started"));
});

test("an empty foreground list with a foreign group never lifts a hold or erases history", async () => {
  const home = `${here.root}.worktrees/lane-ops`;
  const pane = await idlePane("ops", home);
  const stopped = join(home, "state", "stopped");
  const starts = join(home, "state", "starts");
  const history = `${String(Date.now())}\n`;
  writeFileSync(stopped, "held by operator\n");
  writeFileSync(starts, history);
  assert.deepEqual(maintain("empty-busy", pane), action("ops", "unread"));
  assert.equal(readFileSync(stopped, "utf8"), "held by operator\n");
  assert.equal(readFileSync(starts, "utf8"), history);
  const status = records(JSON.parse(fleet(["status", "--json"], "empty-busy", pane)));
  assert.equal(status[0]?.["state"], "unknown");
});

test("a failure after the aside is written still reports where the edited copy was kept", () => {
  const ops = `${here.root}.worktrees/lane-ops`;
  writeFileSync(join(ops, "data", "captain-shared.md"), "local edit\n");
  const content = Buffer.from("- shared\n").toString("base64");
  chmodSync(join(ops, "state"), 0o555);
  try {
    assert.throws(
      () => fleet(["shared", "--content", content]),
      (error: unknown) => {
        const stderr = String(Reflect.get(Object(error), "stderr"));
        assert.match(stderr, /lane ops could not be updated/);
        assert.match(
          stderr,
          /^fleet-preserved: ops: shared preferences incomplete, edited copy preserved as data\/captain-shared\.edited-/m,
        );
        return true;
      },
    );
  } finally {
    chmodSync(join(ops, "state"), 0o755);
  }
  assert.ok(
    readdirSync(join(ops, "data")).some((name) => name.startsWith("captain-shared.edited-")),
  );
});

test("an accepted start is still waited on and reported when recording it fails", async () => {
  const home = `${here.root}.worktrees/lane-ops`;
  await idlePane("ops", home);
  mkdirSync(join(home, "state", "starts.next"));
  const reply = maintain();
  assert.ok(isRecord(reply));
  assert.deepEqual(reply["outcomes"], action("ops", "started"));
  assert.match(String(reply["failed"]), /ops started, but recording the start failed/);
  assert.deepEqual(JSON.parse(fleet(["status", "--json"])), [{ lane: "ops", state: "running" }]);
  assert.deepEqual(maintain(), action("ops", "running"));
});

test("an accepted start keeps the lifecycle lock until Pi shows, even when recording it fails", async () => {
  const home = `${here.root}.worktrees/lane-ops`;
  const pane = await idlePane("ops", home);
  mkdirSync(join(home, "state", "starts.next"));
  const gate = `${faultLog()}.gate`;
  writeFileSync(gate, "");
  const sweep = spawn(process.execPath, [here.launch, ...typedMaintenance], {
    env: {
      ...process.env,
      ...lab.env,
      HERDR_SESSION: lab.name,
      REAL_HERDR: real,
      HERDR_FAULT: "gated-ready",
      HERDR_FAULT_LOG: faultLog(),
      FAULT_PANE: pane,
      FLEET_PROBE_TIMEOUT_MS: "5000",
      FLEET_LIFECYCLE_WAIT_MS: "100",
      PATH: `${bin}:${process.env["PATH"] ?? ""}`,
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  let stdout = "";
  sweep.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  const finished = new Promise<number | null>((resolve, reject) => {
    sweep.once("error", reject);
    sweep.once("close", resolve);
  });
  const deadline = Date.now() + 30_000;
  while (!existsSync(`${faultLog()}.polled`)) {
    assert.ok(Date.now() < deadline, "the sweep never reached its readiness wait");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.throws(() => fleet(["up", "ops", "--json"]), /another fleet command is starting/);
  assert.throws(() => fleet(["stop", "ops"]), /another fleet command is starting/);
  rmSync(gate);
  assert.equal(await finished, 0);
  const reply: unknown = JSON.parse(stdout);
  assert.ok(isRecord(reply));
  assert.deepEqual(reply["outcomes"], action("ops", "started"));
  assert.match(String(reply["failed"]), /ops started, but recording the start failed/);
  assert.deepEqual(JSON.parse(fleet(["up", "ops", "--json"])), action("ops", "running"));
});

test("two current-title workspaces are ambiguous and never pick a pane to start, close, or report", async () => {
  const home = `${here.root}.worktrees/lane-ops`;
  const first = await idlePane("ops", home, "idle-duplicate");
  assert.deepEqual(maintain(), action("ops", "started"));
  const liveId = (await workspace("ops"))?.["workspace_id"];
  assert.ok(typeof liveId === "string");
  assert.deepEqual(maintain(), action("ops", "running"));
  rmSync(join(home, "state", "starts"));
  await lab.run(["workspace", "rename", String(first.split(":")[0]), "2ndmate-ops"]);
  const listed = async () =>
    records((await lab.run(["workspace", "list"]))["workspaces"]).map((row) => row["workspace_id"]);
  const before = await listed();
  assert.equal(before.length, 2);
  assert.deepEqual(maintain(), action("ops", "unread"));
  assert.equal(existsSync(join(home, "state", "starts")), false);
  const status = records(JSON.parse(fleet(["status", "--json"])));
  assert.equal(status[0]?.["state"], "unknown");
  assert.match(String(status[0]["reason"]), /2 workspaces titled 2ndmate-ops/);
  assert.throws(() => fleet(["stop", "ops"]), /2 workspaces titled 2ndmate-ops/);
  assert.throws(() => fleet(["restart", "ops"]), /2 workspaces titled 2ndmate-ops/);
  assert.throws(
    () => fleet(["status", "--placement", "--json"], "pi-in-split", first),
    /2 workspaces titled/,
  );
  assert.deepEqual(await listed(), before);
  assert.equal(existsSync(join(home, "state", "stopped")), false);

  assert.ok(before.includes(liveId));
  const args = typedMaintenance;
  assert.deepEqual(
    maintenanceOutcomes(fleet(args, "omit-id-once", liveId, "5000")),
    action("ops", "unread"),
  );
  assert.ok(existsSync(faultLog()), "the first listing omitted the second workspace");
  const starts = join(home, "state", "starts");
  assert.equal(existsSync(starts), false, "no duplicate launch");
  const recent = `${String(Date.now())}\n`.repeat(3);
  writeFileSync(starts, recent);
  rmSync(faultLog());
  assert.deepEqual(
    maintenanceOutcomes(fleet(args, "omit-id-once", liveId, "5000")),
    action("ops", "unread"),
  );
  assert.equal(readFileSync(starts, "utf8"), recent);
  assert.equal(existsSync(join(home, "state", "stopped")), false, "no false hold");
  rmSync(faultLog());
  assert.throws(
    () => fleet(["stop", "ops"], "omit-id-once", liveId, "5000"),
    /2 workspaces titled/,
  );
  assert.deepEqual(await listed(), before, "neither workspace was closed");
});

test("two legacy workspaces rooted in the home are ambiguous, while unrelated same-title ones are ignored", async () => {
  const home = `${here.root}.worktrees/lane-ops`;
  const idle = await idlePane("ops", home, "fleet-ops");
  const live = await idlePane("ops", home, "fleet-ops");
  await idlePane("ops", here.root, "fleet-ops");
  const listed = async () =>
    records((await lab.run(["workspace", "list"]))["workspaces"]).map((row) => row["workspace_id"]);
  const before = await listed();
  assert.equal(before.length, 3);
  const ambiguous = /2 legacy workspaces rooted in/;
  assert.deepEqual(maintain("pi-in-split", live), action("ops", "unread"));
  assert.equal(existsSync(join(home, "state", "starts")), false);
  const status = records(JSON.parse(fleet(["status", "--json"], "pi-in-split", live)));
  assert.equal(status[0]?.["state"], "unknown");
  assert.match(String(status[0]["reason"]), ambiguous);
  assert.throws(() => fleet(["stop", "ops"]), ambiguous);
  assert.throws(() => fleet(["restart", "ops"]), ambiguous);
  assert.throws(() => fleet(["status", "--placement", "--json"], "pi-in-split", live), ambiguous);
  assert.deepEqual(await listed(), before);
  assert.equal(existsSync(join(home, "state", "stopped")), false);
  await lab.run(["workspace", "close", String(idle.split(":")[0])]);
  assert.deepEqual(maintain("pi-in-split", live), action("ops", "running"));
});

test("restart never counts a surviving legacy mate as its replacement", async () => {
  const home = `${here.root}.worktrees/lane-ops`;
  const legacy = await idlePane("ops", home, "fleet-ops");
  await idlePane("ops", home);
  const labels = async () =>
    records((await lab.run(["workspace", "list"]))["workspaces"]).map((row) => row["label"]);
  const stopped = join(home, "state", "stopped");
  assert.throws(
    () => fleet(["restart", "ops"], "pi-in-split", legacy),
    /still has a running mate in workspace .* after restart closed its own/,
  );
  assert.deepEqual(await labels(), ["fleet-ops"]);
  assert.equal(existsSync(stopped), false);
  assert.equal(existsSync(join(home, "state", "starts")), false);
});

test("status never publishes a definite state over unreadable lifecycle files", async () => {
  const home = `${here.root}.worktrees/lane-ops`;
  await idlePane("ops", home);
  const starts = join(home, "state", "starts");
  const stopped = join(home, "state", "stopped");
  writeFileSync(starts, "");
  const idle = records(JSON.parse(fleet(["status", "--json"])));
  assert.equal(idle[0]?.["state"], "unknown");
  assert.match(String(idle[0]["reason"]), /state\/starts is incomplete/);
  rmSync(starts);
  assert.deepEqual(maintain(), action("ops", "started"));
  mkdirSync(stopped);
  const live = records(JSON.parse(fleet(["status", "--json"])));
  assert.equal(live[0]?.["state"], "unknown");
  assert.match(String(live[0]["reason"]), /could not read state\/stopped/);
  const before = (await workspace("ops"))?.["workspace_id"];
  assert.throws(() => fleet(["stop", "ops"]), /could not read state\/stopped/);
  assert.equal((await workspace("ops"))?.["workspace_id"], before);
});
