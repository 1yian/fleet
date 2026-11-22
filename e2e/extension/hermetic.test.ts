import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { spawnGuarded } from "../support/guarded.ts";
import { HerdrLab } from "../support/herdr.ts";
import { records } from "../support/json.ts";
import { tempDir } from "../support/run-root.ts";

const SIDEBAR = fileURLToPath(new URL("./update-sidebar.test.ts", import.meta.url));
const ONE_TEST = "/updatefleet orders every host's sidebar when no mate starts anywhere";
const PROBE = fileURLToPath(new URL("./cardd-probe.test.ts", import.meta.url));
const PROBE_TEST = "main is told once when cardd refuses new connections";
const LAUNCH = fileURLToPath(new URL("./launch.test.ts", import.meta.url));
const LAUNCH_TEST =
  "fleet up starts a second mate in its own workspace once, and again on its own conversation";
const SHELL_RC_FILES = [".zshenv", ".zshrc", ".zprofile", ".bashrc", ".bash_profile", ".profile"];
const RUN_MS = 240_000;
const GUARDED = new URL("../support/guarded.ts", import.meta.url).href;

let live: string;
let tripwire: string;
beforeEach(() => {
  live = tempDir("fleet-live-");
  tripwire = join(live, "reached-live-p620");
  mkdirSync(join(live, "fleet"));
});
afterEach(() => {
  rmSync(live, { recursive: true, force: true });
});

function liveMateEnvironment(): Record<string, string> {
  const record = `echo "$0" >> '${tripwire}'; exit 255`;
  return {
    FLEET_HOSTS: JSON.stringify({ p620: ["sh", "-c", record] }),
    FLEET_ROOTS: JSON.stringify({ p620: join(live, "p620-fleet") }),
    FLEET_HOST: "maverick",
    FLEET_ROOT: join(live, "fleet"),
    FLEET_CONFIG_DIR: join(live, "config"),
  };
}

function hostWhoseShellPutsAnotherPiFirst(): { env: Record<string, string>; ran: string } {
  const root = tempDir("fleet-host-rc-");
  const bin = join(root, "bin");
  const home = join(root, "home");
  const ran = join(root, "decoy-ran");
  mkdirSync(bin);
  mkdirSync(home);
  writeFileSync(
    join(bin, "pi"),
    `#!/bin/sh\necho "the host's pi ran instead of the repo's Pi" >&2\necho ran >> '${ran}'\nexit 1\n`,
    { mode: 0o755 },
  );
  for (const name of SHELL_RC_FILES)
    writeFileSync(join(home, name), `export PATH='${bin}':"$PATH"\n`);
  const bash = execFileSync("sh", ["-c", "command -v bash"], { encoding: "utf8" }).trim();
  return { env: { HOME: home, ZDOTDIR: home, SHELL: bash }, ran };
}

function runFrom(
  env: Record<string, string>,
  file = SIDEBAR,
  name = ONE_TEST,
): Promise<{ code: string; output: string }> {
  return nodeFrom(env, ["--test", "--test-concurrency=1", `--test-name-pattern=${name}`, file]);
}

async function nodeFrom(
  env: Record<string, string>,
  args: readonly string[],
): Promise<{ code: string; output: string }> {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => name !== "NODE_TEST_CONTEXT"),
  );
  const child = spawnGuarded("node", args, {
    env: { ...inherited, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString()));
  const deadline = setTimeout(() => {
    process.kill(-(child.pid ?? 0), "SIGKILL");
  }, RUN_MS);
  const code = await new Promise<string>((resolve) =>
    child.once("close", (status, signal) => {
      resolve(signal ?? String(status));
    }),
  );
  clearTimeout(deadline);
  return { code, output };
}

test("an end-to-end run started from a shell that carries a live mate's fleet environment reaches only its scratch hosts and homes", async () => {
  const { code, output } = await runFrom(liveMateEnvironment());
  const reached = existsSync(tripwire) ? readFileSync(tripwire, "utf8") : "";
  assert.equal(reached, "", `the run sent commands to the live p620:\n${reached}`);
  assert.deepEqual(readdirSync(join(live, "fleet")), [], "the run wrote into the live checkout");
  assert.equal(existsSync(join(live, "config")), false, "the run wrote the live fleet config");
  assert.equal(code, "0", output.split("\n").slice(-80).join("\n"));
  assert.match(output, /✔ \/updatefleet orders every host's sidebar/);
});

test("an end-to-end run whose host shell puts another pi first on the PATH starts the repo's Pi in every lane pane", async () => {
  const { env, ran } = hostWhoseShellPutsAnotherPiFirst();
  const { code, output } = await runFrom(env, LAUNCH, LAUNCH_TEST);
  assert.equal(
    existsSync(ran),
    false,
    `a lane pane ran the host's pi:\n${output.split("\n").slice(-80).join("\n")}`,
  );
  assert.equal(code, "0", output.split("\n").slice(-80).join("\n"));
  assert.match(output, /✔ fleet up starts a second mate in its own workspace/);
});

test("an end-to-end run started from a worker's herdr pane leaves that pane's workspace alone", async () => {
  const lab = await HerdrLab.start({});
  try {
    const created = await lab.run([
      "workspace",
      "create",
      "--cwd",
      live,
      "--label",
      "└ fleet-shared-browser",
      "--no-focus",
    ]);
    const workspace = String(records([created["workspace"]])[0]?.["workspace_id"]);
    const pane = String(records([created["root_pane"]])[0]?.["pane_id"]);
    const { code, output } = await runFrom(
      {
        HERDR_SOCKET_PATH: await lab.socket(),
        HERDR_WORKSPACE_ID: workspace,
        HERDR_PANE_ID: pane,
      },
      PROBE,
      PROBE_TEST,
    );
    const label = records((await lab.run(["workspace", "list"]))["workspaces"]).map((each) =>
      String(each["label"]),
    );
    assert.deepEqual(label, ["└ fleet-shared-browser"], "the run renamed the worker's workspace");
    assert.equal(code, "0", output.split("\n").slice(-80).join("\n"));
  } finally {
    await lab.stop();
  }
});

test("a herdr command from an end-to-end process that names no lab fails loudly, even when its shell carries a live session", async () => {
  const shell = await HerdrLab.start({});
  try {
    const created = await shell.run([
      "workspace",
      "create",
      "--cwd",
      live,
      "--label",
      "live",
      "--no-focus",
    ]);
    const pane = String(records([created["root_pane"]])[0]?.["pane_id"]);
    const attempt = [
      `await import(${JSON.stringify(GUARDED)});`,
      `const { spawnSync } = await import("node:child_process");`,
      `const made = spawnSync("herdr", ["workspace", "create", "--cwd", process.cwd(), "--label", "leaked", "--no-focus"], { encoding: "utf8" });`,
      `console.log("herdr-result", JSON.stringify({ status: made.status, said: made.stdout + made.stderr }));`,
    ].join("\n");
    const { code, output } = await nodeFrom(
      {
        HERDR_ENV: "1",
        HERDR_SOCKET_PATH: await shell.socket(),
        HERDR_SESSION: shell.name,
        HERDR_PANE_ID: pane,
      },
      ["--input-type=module", "-e", attempt],
    );
    assert.equal(code, "0", output);
    const herdr: unknown = JSON.parse(/^herdr-result (.*)$/m.exec(output)?.[1] ?? "null");
    assert.notEqual(Reflect.get(Object(herdr), "status"), 0, output);
    assert.match(String(Reflect.get(Object(herdr), "said")), /server_not_running/);
    const labels = records((await shell.run(["workspace", "list"]))["workspaces"]).map((each) =>
      String(each["label"]),
    );
    assert.deepEqual(labels, ["live"], "an end-to-end process reached the live herdr session");
  } finally {
    await shell.stop();
  }
});
