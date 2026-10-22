import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { spawnGuarded } from "../support/guarded.ts";
import { tempDir } from "../support/run-root.ts";

const SIDEBAR = fileURLToPath(new URL("./update-sidebar.test.ts", import.meta.url));
const ONE_TEST = "/updatefleet orders every host's sidebar when no mate starts anywhere";
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

async function runFrom(env: Record<string, string>): Promise<{ code: string; output: string }> {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => name !== "NODE_TEST_CONTEXT"),
  );
  const args = ["--test", "--test-concurrency=1", `--test-name-pattern=${ONE_TEST}`, SIDEBAR];
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
