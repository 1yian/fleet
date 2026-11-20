import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { CardSchema, check, OPS } from "@fleet/protocol";
import { quote } from "@fleet/protocol/route";
import { Cardd } from "../support/cardd.ts";
import {
  lastUser,
  type DispatchLab,
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
    host: "local",
    delivery: "local-only",
    task,
  },
});

test("only main bootstraps personal on the named Fleet host, then closes an empty branch without approval", async (t) => {
  const hooks = tempDir("fleet-personal-hooks-");
  for (const name of ["pre-commit", "commit-msg", "reference-transaction"])
    writeFileSync(
      join(hooks, name),
      "#!/bin/sh\necho 'inherited hook must not run' >&2\nexit 1\n",
      { mode: 0o700 },
    );
  const parts = await startDispatchLab({
    freshInstall: true,
    workerShell: true,
    mate: hostEnv,
    cardd: {
      ...hostEnv,
      GIT_CONFIG_COUNT: "3",
      GIT_CONFIG_KEY_0: "commit.gpgsign",
      GIT_CONFIG_VALUE_0: "true",
      GIT_CONFIG_KEY_1: "gpg.program",
      GIT_CONFIG_VALUE_1: "/nonexistent/fleet-test-signer",
      GIT_CONFIG_KEY_2: "core.hooksPath",
      GIT_CONFIG_VALUE_2: hooks,
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
  scriptArtifactHandoff(parts, 2, artifact, checked);
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
  assert.equal(git("config", "--local", "--list").includes("hookspath="), false);
  assert.equal(git("config", "--local", "--list").includes("gpgsign="), false);
});

function scriptArtifactHandoff(
  { h }: DispatchLab,
  card: number,
  artifact: string,
  checked: string,
) {
  h.onModel(
    () => ({ tool: "close", args: { card, summary: "Demo checked and delivered." } }),
    "mate",
  );
  h.onModel(() => ({ text: "closed" }), "mate");
  h.onModel(
    () => ({
      tool: "bash",
      args: { command: `printf 'Demo starts\\n' > '${artifact}' && head -n 1 '${artifact}'` },
    }),
    "worker",
  );
  h.onModel((turns) => {
    assert.match(toolResults(turns).at(-1) ?? "", /^Demo starts/m);
    return { tool: "report", args: { status: "done", text: checked } };
  }, "worker");
}

test("dispatch honors the registered local clone and closes a checked yolo artifact without landing", async (t) => {
  const parts = await startDispatchLab({ workerShell: true, mate: hostEnv, cardd: hostEnv });
  t.after(async () => {
    await parts.lab.printIfFailed(t);
    await stopDispatchLab(parts);
  });
  const { h, mate, cardd, clone } = parts;
  cardd.addProject("personal", { local: clone }, "acme/personal", "direct-PR");
  cardd.yolo("personal");
  const registry = cardd.admin("project", "list").stdout;
  const initial = execFileSync("git", ["-C", clone, "rev-parse", "main"], { encoding: "utf8" });
  const artifact = join(tempDir("fleet-yolo-output-"), "demo.txt");
  const checked = `${artifact}: opened the transcript and confirmed the demo starts`;
  h.onModel(
    () =>
      dispatchUnder(
        "personal",
        `Save and verify the transcript at ${artifact}. Leave the branch unchanged.`,
      ),
    "mate",
  );
  h.onModel(() => ({ text: "dispatched" }), "mate");
  scriptArtifactHandoff(parts, 1, artifact, checked);
  await mateConnected(h);
  mate.prompt("make a gameplay demo");

  const done = await h.waitForCall(2, "mate", WORKER_WAIT_MS);
  assert.equal(toolResults(done)[0], "Dispatched c-1-a1 on local, branch c-1-a1.");
  assert.equal(
    lastUser(done),
    `[fleet] c-1 gameplay-demo done: ${checked} (local-only: the branch is empty, so nothing lands) (card now merging)`,
  );
  assert.deepEqual((await cardd.board()).holds, []);
  const closed = await h.waitForCall(3, "mate", WORKER_WAIT_MS);
  assert.equal(toolResults(closed).at(-1), "c-1 is done.");
  assert.equal(readFileSync(artifact, "utf8"), "Demo starts\n");
  assert.equal(
    execFileSync("git", ["-C", clone, "rev-parse", "main"], { encoding: "utf8" }),
    initial,
  );
  assert.equal(cardd.admin("project", "list").stdout, registry);
});

test("bootstrap uses the default native host without inferring a custom route", async (t) => {
  const home = tempDir("fleet-personal-native-");
  const cardd = await Cardd.start({ FLEET_HOST: "", FLEET_HOST_DIR: home }, ["--hosts", "{}"]);
  t.after(() => cardd.stop());
  const main = await cardd.connect(cardd.addLane("main"));
  const clone = join(home, "projects", "personal");
  await assert.rejects(
    main.call("project.personal", { host: fleetHost }),
    /no host route configured/,
  );
  assert.equal(existsSync(clone), false);
  assert.equal(cardd.admin("project", "list").stdout, "");
  const native = hostname().toLowerCase().split(".")[0];
  assert.equal(await main.call("project.personal", { host: native }), true);
  assert.deepEqual(worktreesOf(clone), ["branch refs/heads/main"]);
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

const CARDD_CLI = fileURLToPath(new URL("../../packages/cardd/src/main.ts", import.meta.url));

for (const [cloneHost, losesReply] of [
  ["race-host", false],
  ["RACE-HOST", false],
  ["race-host", true],
  ["RACE-HOST", true],
] as const) {
  const response = losesReply ? "after a lost provisioning reply" : "after an insert conflict";
  test(`bootstrap honors the administrator clone key ${cloneHost} ${response}`, async (t) => {
    const home = tempDir("fleet-personal-race-");
    const registered = join(home, "admin-clone");
    execFileSync("git", ["init", "-q", "-b", "main", registered]);
    const register = join(home, "register-project");
    const route = losesReply
      ? 'set -e; sh -c "$2" >/dev/null; . "$1"; exit 255'
      : 'set -e; sh -c "$2"; . "$1"';
    const cardd = await Cardd.start({ FLEET_HOST_DIR: home }, [
      "--hosts",
      JSON.stringify({ "race-host": ["sh", "-c", route, "transport", register] }),
    ]);
    t.after(() => cardd.stop());
    writeFileSync(
      register,
      [
        process.execPath,
        CARDD_CLI,
        "project",
        "add",
        "personal",
        "--db",
        cardd.db,
        "--delivery",
        "direct-PR",
        "--repo",
        "acme/owned-personal",
        "--yolo",
        "--clone",
        `${cloneHost}=${registered}`,
      ]
        .map(quote)
        .join(" "),
    );
    const main = await cardd.connect(cardd.addLane("main"));
    const bootstrap = main.call("project.personal", { host: "race-host" });
    if (cloneHost === "race-host") {
      assert.equal(await bootstrap, true);
      const card = check(
        CardSchema,
        await main.call("card.new", {
          title: "Use admin project",
          kind: "ship",
          project: "personal",
        }),
      );
      const attempt = check(
        OPS["attempt.begin"].result,
        await main.call("attempt.begin", {
          card: card.id,
          host: cloneHost,
          task: "Work on the admin clone",
        }),
      );
      assert.equal(attempt.clone, registered);
      assert.equal(attempt.delivery, "direct-PR");
    } else {
      await assert.rejects(
        bootstrap,
        /no clone on race-host.*Registered clone hosts: RACE-HOST.*administrator can add a clone/,
      );
    }
    assert.equal(
      cardd.admin("project", "list").stdout,
      `personal: direct-PR, yolo on, repo acme/owned-personal, ${cloneHost}=${registered}`,
    );
    assert.deepEqual(worktreesOf(join(home, "projects", "personal")), ["branch refs/heads/main"]);
  });
}

test("bootstrap retries after a failed commit or a lost framed reply", async (t) => {
  const home = tempDir("fleet-personal-retry-");
  const fail = join(home, "invalid-commit-date");
  writeFileSync(fail, "");
  const drop = join(home, "drop-reply");
  const route = `
    if [ -e "$1" ]; then export GIT_AUTHOR_DATE=not-a-date; fi
    if [ -e "$2" ]; then sh -c "$3" >/dev/null && echo "startup banner"; else exec sh -c "$3"; fi`;
  const cardd = await Cardd.start(
    {
      FLEET_HOST_DIR: home,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "status.showUntrackedFiles",
      GIT_CONFIG_VALUE_0: "no",
    },
    ["--hosts", JSON.stringify({ retry: ["sh", "-c", route, "transport", fail, drop] })],
  );
  t.after(() => cardd.stop());
  const main = await cardd.connect(cardd.addLane("main"));
  const bootstrap = () => main.call("project.personal", { host: "retry" });
  const clone = join(home, "projects", "personal");
  const head = () => execFileSync("git", ["-C", clone, "rev-parse", "HEAD"], { encoding: "utf8" });

  await assert.rejects(bootstrap(), /invalid date format/);
  assert.equal(existsSync(clone), false);
  assert.equal(cardd.admin("project", "list").stdout, "");

  rmSync(fail);
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
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", clone, ...args], { encoding: "utf8" });
  git("branch", "operator-work");
  await assert.rejects(bootstrap(), /existing directory is not an empty Fleet bootstrap/);
  assert.equal(git("rev-parse", "operator-work"), published);
  git("branch", "-d", "operator-work");

  const linked = join(home, "linked");
  git("worktree", "add", "--detach", linked, "main");
  await assert.rejects(bootstrap(), /existing directory is not an empty Fleet bootstrap/);
  assert.equal(existsSync(linked), true);
  git("worktree", "remove", linked);
  assert.equal(cardd.admin("project", "list").stdout, "");

  assert.equal(await bootstrap(), true);
  assert.equal(head(), published);
  assert.equal(
    cardd.admin("project", "list").stdout,
    `personal: local-only, yolo off, repo not set, retry=${clone}`,
  );
});
