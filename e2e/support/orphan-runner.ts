import { Harness } from "./harness.ts";
import { HerdrLab } from "./herdr.ts";
import { begin, newCard, startFleet } from "./fleet.ts";
import { records } from "./json.ts";
import { Scratch } from "./scratch.ts";

const sleeper = `sleep 4${String(Math.floor(Math.random() * 1e6)).padStart(6, "0")}`;

const fleet = await startFleet({ CARDD_TIMING_SCALE: "0.001" });
await begin(fleet.main, await newCard(fleet.main, "a card whose PR cardd keeps polling"));
const scratch = new Scratch();
const h = await Harness.start();
h.startPi("main");
const lab = await HerdrLab.start(h.piEnv("worker"));
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
    lab: lab.name,
    dirs: [scratch.parent, h.dir, fleet.cardd.db],
  }),
);
setInterval(() => undefined, 1 << 30);
