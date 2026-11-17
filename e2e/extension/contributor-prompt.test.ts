import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Cardd } from "../support/cardd.ts";
import { Harness, type Turn } from "../support/harness.ts";
import { HerdrLab } from "../support/herdr.ts";
import { configureMain, mateArgs, Scratch, startMain } from "../support/scratch.ts";

const systemOf = (turns: readonly Turn[]): string =>
  turns.find((turn) => turn.role === "system")?.text ?? "";

function evidence(name: string, turns: readonly Turn[]): void {
  const dir = process.env["FLEET_PROMPT_EVIDENCE"];
  if (dir === undefined) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.json`), JSON.stringify(turns, null, 2));
}

async function workerCall(h: Harness, guided: boolean): Promise<Turn[]> {
  for (let call = 0; ; call += 1) {
    const turns = await h.waitForCall(call, "mate", 90_000);
    if (
      systemOf(turns).includes("# Worker role contract") &&
      (!guided || turns.some((turn) => turn.role === "toolResult"))
    )
      return turns;
  }
}

test("mates load runtime instructions while a dispatched fleet contributor follows the worker-only guide", async (t) => {
  const scratch = new Scratch();
  const cardd = await Cardd.start();
  const h = await Harness.start();
  const args = mateArgs(h).filter(
    (arg) => !["--no-context-files", "--no-builtin-tools"].includes(arg),
  );
  const bin = fileURLToPath(new URL("../../node_modules/.bin", import.meta.url));
  const lab = await HerdrLab.start({
    ...h.piEnv("mate"),
    PATH: [bin, process.env["PATH"] ?? ""].join(delimiter),
  });
  t.after(async () => {
    await lab.printIfFailed(t);
    await lab.stop();
    await h.stop();
    await cardd.stop();
    scratch.dispose();
  });
  const token = cardd.addLane("main", undefined, scratch.root);
  configureMain(scratch, cardd.url, token, { workerArgs: args });
  cardd.addProject("fleet", { local: scratch.root }, undefined, "no-mistakes");
  mkdirSync(join(scratch.root, "data"), { recursive: true });
  for (const [file, text] of Object.entries({
    "charter.md": "## Lab charter\n\nKeep the fixture fleet running.\n",
    "captain-shared.md": "Prefer plain reports.\n",
    "captain.md": "Keep this lane focused.\n",
    "learnings.md": "Use the isolated lab.\n",
  }))
    writeFileSync(join(scratch.root, "data", file), text);

  const dispatch = {
    tool: "dispatch",
    args: {
      title: "Contributor prompt reaches the worker",
      name: "contributor-prompt",
      kind: "scout",
      project: "fleet",
      intent: "Inspect contributor instructions",
      task: "Inspect your repository instructions without changing files.",
      host: "local",
    },
  } as const;
  let dispatched = false;
  for (let call = 0; call < 12; call += 1)
    h.onModel((turns) => {
      if (!systemOf(turns).includes("# Worker role contract")) {
        evidence("mate", turns);
        if (dispatched) return { text: "dispatched" };
        dispatched = true;
        return dispatch;
      }
      if (turns.some((turn) => turn.role === "toolResult")) {
        evidence("worker-with-guide", turns);
        return { text: "Contributor instructions received." };
      }
      evidence("worker-first", turns);
      if (!systemOf(turns).includes("CONTRIBUTING.md")) return { text: "No contributor pointer." };
      return { tool: "read", args: { path: "CONTRIBUTING.md" } };
    }, "mate");
  const pane = await startMain(lab, scratch, h, false, args);
  await h.waitFor((event) => event["type"] === "fleet_connected", "the mate to connect");
  await lab.submit(pane, "Inspect contributor prompt routing.");
  const mate = await h.waitForCall(0, "mate", 90_000);
  const worker = await workerCall(h, false);
  evidence("mate", mate);
  assert.match(systemOf(mate), /^# Firstmate$/m);
  assert.match(systemOf(mate), /Keep the fixture fleet running/);
  assert.match(systemOf(mate), /Prefer plain reports/);
  assert.match(systemOf(mate), /Keep this lane focused/);
  assert.match(systemOf(mate), /Use the isolated lab/);
  assert.doesNotMatch(systemOf(mate), /npm run check|fleet\/no-comments|Migrations.*append-only/);
  assert.match(systemOf(worker), /^# Worker role contract$/m);
  assert.doesNotMatch(systemOf(worker), /^# Firstmate$/m);
  assert.match(systemOf(worker), /Workers.*CONTRIBUTING\.md/);
  assert.doesNotMatch(systemOf(worker), /Keep the fixture fleet running|Prefer plain reports/);
  const guided = await workerCall(h, true);
  const guide = guided.findLast((turn) => turn.role === "toolResult")?.text ?? "";
  assert.match(guide, /npm run check/);
  assert.match(guide, /fleet\/no-comments/);
  assert.match(guide, /Migrations.*append-only/);
  assert.match(guide, /Do not test by reading source files for strings/);
});
