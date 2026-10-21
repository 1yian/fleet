import { fileURLToPath } from "node:url";
import { Harness } from "./harness.ts";
import { HerdrLab } from "./herdr.ts";
import { begin, newCard, startFleet } from "./fleet.ts";
import { records } from "./json.ts";
import { Scratch, startMain } from "./scratch.ts";

process.stdin.once("end", () => {
  process.exit(0);
});
process.stdin.resume();

const sleeper = `sleep 4${String(Math.floor(Math.random() * 1e6)).padStart(6, "0")}`;

const fleet = await startFleet({ CARDD_TIMING_SCALE: "0.001" });
await begin(fleet.main, await newCard(fleet.main, "a card whose PR cardd keeps polling"));
const scratch = new Scratch();
const h = await Harness.start();
h.startPi("main");
await h.waitFor((event) => event["type"] === "session", "the directly spawned Pi to start");
const lab = await HerdrLab.start({
  ...h.piEnv("worker"),
  PATH: `${fileURLToPath(new URL("../../node_modules/.bin", import.meta.url))}:${process.env["PATH"] ?? ""}`,
});
const piPane = await startMain(lab, scratch, h, false, h.piArgs());
await h.waitForNth((event) => event["type"] === "session", 2, "the Pi in the lab pane to start");
const paneInfo = await lab.run(["pane", "process-info", "--pane", piPane]);
const panePi = records([paneInfo["process_info"]])[0]?.["foreground_process_group_id"];
const created = await lab.run([
  "workspace",
  "create",
  "--cwd",
  scratch.root,
  "--label",
  "runner",
  "--no-focus",
]);
const pane = String(records([created["root_pane"]])[0]?.["pane_id"]);
await lab.submit(pane, sleeper);

console.log(
  JSON.stringify({
    ready: true,
    sleeper,
    panePi,
    lab: lab.name,
    dirs: [scratch.parent, h.dir, fleet.cardd.db],
  }),
);
setInterval(() => undefined, 1 << 30);
