import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Cardd } from "../support/cardd.ts";
import { HerdrLab } from "../support/herdr.ts";
import { records } from "../support/json.ts";

const EXTENSION = fileURLToPath(new URL("../../packages/extension/src/index.ts", import.meta.url));
const BOARD = fileURLToPath(new URL("../../packages/board/dist", import.meta.url));
const [clone = "", model = "tier/quick"] = process.argv.slice(2);
if (clone === "") throw new Error("usage: node e2e/trial/trial.ts <project clone> [model]");

const dir = mkdtempSync(join(tmpdir(), "fleet-trial-"));
const home = join(dir, "homes", "main");
mkdirSync(home, { recursive: true });
writeFileSync(
  join(home, "AGENTS.md"),
  "# Main lane\n\nThis lane owns every project in the registry.\n",
);

const cardd = await Cardd.start({ PATH: process.env["PATH"] ?? "" }, ["--board", BOARD]);
const token = cardd.addLane("main", undefined, home);
const name = clone.split("/").at(-1) ?? "project";
cardd.addProject(name, { local: clone });
const piArgs = ["-e", EXTENSION, "--model", model];
const lab = await HerdrLab.start({ FLEET_PI_ARGS: JSON.stringify(piArgs) });

const created = await lab.run([
  "workspace",
  "create",
  "--cwd",
  home,
  "--label",
  "main",
  "--no-focus",
]);
const [pane] = records([created["root_pane"]]).map((each) => each["pane_id"]);
if (typeof pane !== "string") throw new Error("the lab returned no pane");
const fleet = [`--fleet-url=${cardd.url}`, `--fleet-token=${token}`, "--fleet-role=mate"];
execFileSync(
  "herdr",
  [
    "agent",
    "start",
    "main",
    "--kind",
    "pi",
    "--pane",
    pane,
    "--session",
    lab.name,
    "--",
    ...fleet,
    ...piArgs,
  ],
  {
    env: { ...process.env, HERDR_SESSION: lab.name },
    stdio: "inherit",
  },
);

const board = cardd.url.replace(/^ws/, "http").replace(/\/session$/, "/");
console.log(`trial ready
  folder:  ${dir}
  board:   ${board}
  db:      ${cardd.db}
  lab:     ${lab.name}   (watch: herdr --session ${lab.name})
  prompt:  herdr agent prompt main "<text>" --session ${lab.name}
  project: ${name} at ${clone}, model ${model}`);

const stop = (): void => {
  void Promise.allSettled([lab.stop(), cardd.stop()]).then(() => process.exit(0));
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
setInterval(() => undefined, 60_000);
