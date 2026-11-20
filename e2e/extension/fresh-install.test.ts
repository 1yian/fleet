import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Cardd } from "../support/cardd.ts";
import {
  lastUser,
  mateConnected,
  startDispatchLab,
  stopDispatchLab,
  toolResults,
  WORKER_WAIT_MS,
  worktreesOf,
} from "../support/dispatch-lab.ts";
import { tempDir } from "../support/run-root.ts";

const fleetHost = "fleet-personal-lab";
const hostEnv = { FLEET_HOST: fleetHost };

const dispatchUnder = (project: string) => ({
  tool: "dispatch",
  args: {
    title: "Scratch gameplay demo video",
    name: "gameplay-demo",
    kind: "ship",
    project,
    intent: "Make me a gameplay demo video of my Scratch game",
    host: "local",
    task: "Record the demo, then play the video back and check it before you report done",
  },
});

test("only main bootstraps personal on the named Fleet host, then closes an empty branch without approval", async (t) => {
  const parts = await startDispatchLab({
    freshInstall: true,
    mate: hostEnv,
    cardd: {
      ...hostEnv,
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "commit.gpgsign",
      GIT_CONFIG_VALUE_0: "true",
      GIT_CONFIG_KEY_1: "gpg.program",
      GIT_CONFIG_VALUE_1: "/nonexistent/fleet-test-signer",
    },
  });
  t.after(async () => {
    await parts.lab.printIfFailed(t);
    await stopDispatchLab(parts);
  });
  const { h, mate, cardd, clone } = parts;
  const oldHome = tempDir("fleet-old-lane-");
  mkdirSync(join(oldHome, "config"));
  writeFileSync(join(oldHome, "config", "lane.json"), JSON.stringify({ host: fleetHost }));
  const second = await cardd.connect(cardd.addLane("second", "main", oldHome));
  await assert.rejects(second.call("project.personal", { host: fleetHost }), /only main.*Ask main/);
  await second.close();
  assert.equal(cardd.admin("project", "list").stdout, "");
  assert.equal(existsSync(clone), false);

  h.onModel(() => ({ tool: "board", args: {} }), "mate");
  h.onModel(() => dispatchUnder("fleet"), "mate");
  h.onModel(() => dispatchUnder("personal"), "mate");
  h.onModel(() => ({ text: "dispatched" }), "mate");
  h.onModel(
    () => ({ tool: "close", args: { card: 2, summary: "Demo video checked and delivered." } }),
    "mate",
  );
  h.onModel(() => ({ text: "closed" }), "mate");
  h.onModel(
    () => ({ tool: "report", args: { status: "done", text: "video played back and checked" } }),
    "worker",
  );
  await mateConnected(h);
  mate.prompt("make a gameplay demo video of my Scratch game");

  const woken = await h.waitForCall(4, "mate", WORKER_WAIT_MS);
  const results = toolResults(woken);
  assert.match(results[0] ?? "", /^projects: 0 registered$/m);
  assert.match(
    results[1] ?? "",
    /project fleet is not registered, so nothing was created\..*project "personal".*Never do the work yourself/,
  );
  assert.equal(results[2], `Dispatched c-2-a1 on ${fleetHost}, branch c-2-a1.`);

  const workerFirst = await h.waitForCall(0, "worker");
  assert.equal(
    lastUser(workerFirst),
    "[fleet] main on c-2 gameplay-demo: Record the demo, then play the video back and check it before you report done\n\nDelivery: local-only",
  );
  assert.equal(
    lastUser(woken),
    "[fleet] c-2 gameplay-demo done: video played back and checked (local-only: the branch is empty, so nothing lands) (card now with-mate)",
  );
  assert.deepEqual((await cardd.board()).holds, []);
  const closed = await h.waitForCall(5, "mate", WORKER_WAIT_MS);
  assert.equal(toolResults(closed).at(-1), "c-2 is done.");

  assert.equal(
    cardd.admin("project", "list").stdout,
    `personal: local-only, yolo off, repo not set, ${fleetHost}=${clone}`,
  );
  assert.deepEqual(
    (await cardd.board()).cards
      .filter((card) => card.project !== null)
      .map((card) => [card.id, card.project, card.kind]),
    [[2, "personal", "ship"]],
  );
  assert.deepEqual(worktreesOf(clone), ["branch refs/heads/main"]);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", clone, ...args], { encoding: "utf8" }).trim();
  assert.equal(git("rev-list", "--count", "main"), "1");
  assert.equal(git("rev-list", "--max-parents=0", "main"), git("rev-parse", "main"));
  assert.equal(git("ls-tree", "-r", "main"), "");
});

test("bootstrap leaves an occupied checkout untouched and only provisions the winning host", async (t) => {
  const local = tempDir("fleet-personal-local-");
  const first = tempDir("fleet-personal-first-");
  const second = tempDir("fleet-personal-second-");
  const cardd = await Cardd.start({ ...hostEnv, FLEET_HOST_DIR: local }, [
    "--hosts",
    JSON.stringify({
      first: ["env", `FLEET_HOST_DIR=${first}`, "sh", "-c"],
      second: ["env", `FLEET_HOST_DIR=${second}`, "sh", "-c"],
    }),
  ]);
  t.after(() => cardd.stop());
  const main = await cardd.connect(cardd.addLane("main"));
  const occupied = join(local, "projects", "personal");
  mkdirSync(occupied, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", occupied]);
  const existing = join(occupied, "owned.txt");
  writeFileSync(existing, "existing work");

  await assert.rejects(main.call("project.personal", { host: fleetHost }), /existing directory/);
  assert.equal(readFileSync(existing, "utf8"), "existing work");
  assert.equal(cardd.admin("project", "list").stdout, "");
  await assert.rejects(main.call("project.personal", { host: "local" }), /canonical host.*local/);
  await assert.rejects(
    main.call("project.personal", { host: "unknown-lab-host" }),
    /no host route configured for unknown-lab-host/,
  );

  await Promise.all([
    main.call("project.personal", { host: "first" }).then((ack) => assert.equal(ack, true)),
    assert.rejects(
      main.call("project.personal", { host: "second" }),
      /no clone on second.*Registered clone hosts: first/,
    ),
  ]);
  assert.equal(await main.call("project.personal", { host: "first" }), true);
  assert.equal(existsSync(join(second, "projects")), false);
  assert.equal(
    cardd.admin("project", "list").stdout,
    `personal: local-only, yolo off, repo not set, first=${join(first, "projects", "personal")}`,
  );
});
