import assert from "node:assert/strict";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, test } from "node:test";
import type { Move } from "../support/harness.ts";
import { LiveFleet, lastUser, systemOf, until } from "../support/live-fleet.ts";

const TODAY = new Date().toISOString().slice(0, 10);
const AGENTS_RULE = "AGENTS-RULE-ADDED-AFTER-START";
const NOW_LINE = "reconnected on a new process";
const NO_SAFE_RELOADS =
  "runs code from before safe reloads, so it was left running: restart it by hand";

let fleet: LiveFleet;
beforeEach(async () => {
  fleet = await LiveFleet.start();
});
afterEach(async (t) => {
  await fleet.lab.printIfFailed(t);
  await fleet.stop();
});

const learnings = (home: string): string => join(home, "data", "learnings.md");

function seed(home: string, who: string): void {
  mkdirSync(join(home, "data"), { recursive: true });
  writeFileSync(learnings(home), `- ${who}-FRESH <!--a:${TODAY}-->\n`);
}

const stowed = (who: string): string =>
  `- ${who}-FRESH <!--a:${TODAY}-->\n- ${who}-NEW <!--a:${TODAY}-->\n`;

function script(): void {
  for (let call = 0; call < 120; call += 1) {
    fleet.h.onModel((turns) => {
      const at = turns.findLastIndex((turn) => turn.role === "user");
      if (!(turns[at]?.text ?? "").startsWith("[stow]")) return { text: "noted" };
      const done = turns.slice(at).filter((turn) => turn.role === "toolResult").length;
      const system = systemOf(turns);
      const who = ["MAIN", "OPS", "FAR"].find((each) => system.includes(`${each}-FRESH`));
      const write: Move = {
        tool: "write",
        args: { path: "data/learnings.md", content: stowed(who ?? "NOBODY") },
      };
      return done === 0 ? write : { text: "Stowed, captain." };
    }, "mate");
    fleet.h.onModel((turns) => {
      const user = turns.findLast((turn) => turn.role === "user")?.text ?? "";
      const done = turns.filter((turn) => turn.role === "toolResult").length;
      if (!user.includes("START-")) return { text: "ok" };
      const until = new Date(Date.now() + 3_600_000).toISOString();
      const pause: Move = { tool: "report", args: { status: "paused", text: "waiting", until } };
      return done === 0 ? pause : { text: "paused" };
    }, "worker");
  }
}

const maintenanceRows = (): string[][] => {
  const db = new DatabaseSync(fleet.cardd.db, { readOnly: true });
  try {
    return db
      .prepare("SELECT session, kind, state FROM maintenance ORDER BY session")
      .all()
      .map((row) => [String(row["session"]), String(row["kind"]), String(row["state"])]);
  } finally {
    db.close();
  }
};

test("/stow in main stows every second mate in its own conversation and memory, skips workers, reloads each with its AGENTS.md, and main hears who finished and who could not", async () => {
  script();
  seed(fleet.here.root, "MAIN");
  seed(fleet.opsHome, "OPS");
  seed(fleet.farHome, "FAR");
  await fleet.startMain();
  const was = { ops: await fleet.matePid("ops"), far: await fleet.matePid("far") };
  const worker = await fleet.startWorker("sleeper", "local");
  await until(
    async () => ((await fleet.cardOf(worker.card)).status === "paused" ? true : undefined),
    "the worker to pause",
  );
  const workerPid = await until(() => fleet.piIn(worker.pane), "the worker's Pi");
  const sessions = ["ops", "far"].map(
    (lane) =>
      fleet.h.events.filter(
        (event) =>
          event["type"] === "session" &&
          event["cwd"] === realpathSync(lane === "ops" ? fleet.opsHome : fleet.farHome),
      ).length,
  );
  appendFileSync(join(fleet.opsHome, "AGENTS.md"), `\n${AGENTS_RULE}\n`);

  await fleet.lab.submit(fleet.mainPane, "/stow");
  await until(
    () =>
      fleet
        .userTexts("mate")
        .some((text) => text.startsWith("[stow]") && text.includes("MAIN-FRESH"))
        ? true
        : undefined,
    "main's own stow",
  );
  const opsPid = await fleet.newPid((await fleet.paneOf("2ndmate-ops")) ?? "", was.ops);
  const farPid = await fleet.newPid((await fleet.paneOf("2ndmate-far")) ?? "", was.far);
  assert.ok(opsPid !== was.ops && farPid !== was.far);

  assert.equal(readFileSync(learnings(fleet.opsHome), "utf8"), stowed("OPS"));
  assert.equal(readFileSync(learnings(fleet.farHome), "utf8"), stowed("FAR"));
  await until(
    () => (readFileSync(learnings(fleet.here.root), "utf8") === stowed("MAIN") ? true : undefined),
    "main's own memory",
  );
  const messages = [
    ...new Set(fleet.userTexts("mate").filter((text) => text.startsWith("[stow]"))),
  ];
  assert.equal(messages.length, 3);
  for (const message of messages) {
    const own = ["MAIN", "OPS", "FAR"].filter((who) => message.includes(`${who}-FRESH`));
    assert.equal(own.length, 1);
  }
  await until(() => {
    const counts = [fleet.opsHome, fleet.farHome].map(
      (home, index) => fleet.sessionEvents(realpathSync(home)).length - (sessions[index] ?? 0),
    );
    return counts.every((count) => count === 1) ? true : undefined;
  }, "each second mate to start exactly one new session");

  await fleet.lab.submit((await fleet.paneOf("2ndmate-ops")) ?? "", "HELLO-AFTER-STOW");
  const after = await until(
    () => fleet.h.callsOf("mate").find((turns) => lastUser(turns).includes("HELLO-AFTER-STOW")),
    "ops to answer after the stow",
  );
  assert.match(systemOf(after), /OPS-NEW/);
  assert.match(systemOf(after), RegExp(AGENTS_RULE));
  assert.equal(await fleet.piIn(worker.pane), workerPid);
  assert.equal((await fleet.cardOf(worker.card)).status, "paused");

  const finished = ["ops", "far"].map(
    (lane) => `[fleet] maintenance: ${lane} (mate): stow completed - ${NOW_LINE}`,
  );
  await until(
    () => (existsSync(learnings(fleet.here.root)) ? true : undefined),
    "main's own stow to finish",
  );
  await fleet.matePid("main");
  await fleet.lab.submit(fleet.mainPane, "WHO-STOWED");
  const heard = await until(
    () =>
      fleet.h
        .callsOf("mate")
        .find(
          (turns) =>
            lastUser(turns).includes("WHO-STOWED") &&
            finished.every((line) => turns.some((turn) => turn.text === line)),
        ),
    "main to hear both stows finish",
  );
  const told = heard.map((turn) => turn.text);
  assert.ok(told.includes(`[fleet] maintenance: ops (mate): stow completed - ${NOW_LINE}`));
  assert.ok(told.includes(`[fleet] maintenance: far (mate): stow completed - ${NOW_LINE}`));
  const cascade = told.find((text) => text.startsWith("[fleet] stow cascade:")) ?? "";
  assert.match(
    cascade,
    new RegExp(`Unable to stow:\\n- ghost \\(mate\\): stow failed - ${NO_SAFE_RELOADS}`),
  );
  assert.deepEqual(maintenanceRows(), [
    ["far", "stow", "completed"],
    ["ghost", "stow", "failed"],
    ["ops", "stow", "completed"],
  ]);
  assert.equal(existsSync(learnings(fleet.here.root)), true);
});
