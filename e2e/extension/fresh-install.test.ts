import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
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

const dispatchUnder = (project: string, task: string) => ({
  tool: "dispatch",
  args: {
    title: "Scratch gameplay demo video",
    name: "gameplay-demo",
    kind: "ship",
    project,
    intent: "Make me a gameplay demo video of my Scratch game",
    host: project === "personal" ? hostname() : "local",
    task,
  },
});

test("only main bootstraps personal on the named Fleet host, then closes an empty branch without approval", async (t) => {
  const parts = await startDispatchLab({
    freshInstall: true,
    workerShell: true,
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

  const artifact = join(tempDir("fleet-demo-output-"), "demo.txt");
  const task = `Save the demo transcript at ${artifact}, open it to verify it, and leave the branch unchanged.`;
  const checked = `${artifact}: opened the transcript and confirmed the demo starts`;
  h.onModel(() => ({ tool: "board", args: {} }), "mate");
  h.onModel(() => dispatchUnder("fleet", task), "mate");
  h.onModel(() => dispatchUnder("personal", task), "mate");
  h.onModel(() => ({ text: "dispatched" }), "mate");
  h.onModel(
    () => ({ tool: "close", args: { card: 2, summary: "Demo video checked and delivered." } }),
    "mate",
  );
  h.onModel(() => ({ text: "closed" }), "mate");
  h.onModel(
    () => ({
      tool: "bash",
      args: { command: `printf 'Demo starts\\n' > '${artifact}'; head -n 1 '${artifact}'` },
    }),
    "worker",
  );
  h.onModel((turns) => {
    assert.match(toolResults(turns).at(-1) ?? "", /Demo starts/);
    return { tool: "report", args: { status: "done", text: checked } };
  }, "worker");
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
    `[fleet] main on c-2 gameplay-demo: ${task}\n\nDelivery: local-only`,
  );
  assert.equal(
    lastUser(woken),
    `[fleet] c-2 gameplay-demo done: ${checked} (local-only: the branch is empty, so nothing lands) (card now with-mate)`,
  );
  assert.deepEqual((await cardd.board()).holds, []);
  const closed = await h.waitForCall(5, "mate", WORKER_WAIT_MS);
  assert.equal(toolResults(closed).at(-1), "c-2 is done.");
  assert.equal(readFileSync(artifact, "utf8"), "Demo starts\n");

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
      LOCAL: [
        "env",
        `FLEET_HOST_DIR=${first}`,
        "sh",
        "-c",
        'echo startup-banner; exec sh -c "$1"',
        "transport",
      ],
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
    main.call("project.personal", { host: "LOCAL" }).then((ack) => assert.equal(ack, true)),
    assert.rejects(
      main.call("project.personal", { host: "second" }),
      /no clone on second.*Registered clone hosts: LOCAL/,
    ),
  ]);
  assert.equal(await main.call("project.personal", { host: "LOCAL" }), true);
  assert.equal(existsSync(join(second, "projects")), false);
  assert.equal(
    cardd.admin("project", "list").stdout,
    `personal: local-only, yolo off, repo not set, LOCAL=${join(first, "projects", "personal")}`,
  );
});

test("bootstrap retries after a failed commit or a lost framed reply", async (t) => {
  const home = tempDir("fleet-personal-retry-");
  const hooks = join(home, "hooks");
  mkdirSync(hooks);
  const hook = join(hooks, "pre-commit");
  writeFileSync(hook, "#!/bin/sh\necho 'hook stopped bootstrap' >&2\nexit 1\n", { mode: 0o700 });
  const drop = join(home, "drop-reply");
  const route =
    'if [ -e "$1" ]; then sh -c "$2" >/dev/null && echo "startup banner"; else exec sh -c "$2"; fi';
  const cardd = await Cardd.start(
    {
      FLEET_HOST_DIR: home,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.hooksPath",
      GIT_CONFIG_VALUE_0: hooks,
    },
    ["--hosts", JSON.stringify({ retry: ["sh", "-c", route, "transport", drop] })],
  );
  t.after(() => cardd.stop());
  const main = await cardd.connect(cardd.addLane("main"));
  const bootstrap = () => main.call("project.personal", { host: "retry" });
  const clone = join(home, "projects", "personal");
  const head = () => execFileSync("git", ["-C", clone, "rev-parse", "HEAD"], { encoding: "utf8" });

  await assert.rejects(bootstrap(), /hook stopped bootstrap/);
  assert.equal(existsSync(clone), false);
  assert.equal(cardd.admin("project", "list").stdout, "");

  rmSync(hook);
  writeFileSync(drop, "");
  await assert.rejects(bootstrap(), /invalid personal clone path from retry/);
  const published = head();
  assert.equal(cardd.admin("project", "list").stdout, "");

  rmSync(drop);
  const extra = join(clone, "not-bootstrap-work.txt");
  writeFileSync(extra, "preserve this\n");
  await assert.rejects(bootstrap(), /existing directory is not an empty Fleet bootstrap/);
  assert.equal(readFileSync(extra, "utf8"), "preserve this\n");
  assert.equal(cardd.admin("project", "list").stdout, "");

  rmSync(extra);
  assert.equal(await bootstrap(), true);
  assert.equal(head(), published);
  assert.equal(
    cardd.admin("project", "list").stdout,
    `personal: local-only, yolo off, repo not set, retry=${clone}`,
  );
});
