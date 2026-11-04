import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
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
const RUN_MS = 240_000;

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

async function runFrom(
  env: Record<string, string>,
  file = SIDEBAR,
  name = ONE_TEST,
): Promise<{ code: string; output: string }> {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => name !== "NODE_TEST_CONTEXT"),
  );
  const args = ["--test", "--test-concurrency=1", `--test-name-pattern=${name}`, file];
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
