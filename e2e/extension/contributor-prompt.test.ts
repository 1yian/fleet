import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { test, type TestContext } from "node:test";
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

async function workerCall(h: Harness): Promise<Turn[]> {
  for (let call = 0; ; call += 1) {
    const turns = await h.waitForCall(call, "mate", 90_000);
    if (systemOf(turns).includes("# Worker role contract")) return turns;
  }
}

const STALE_OVERVIEW = "# fleet\n\nStale overview of the fleet repository.\n";
const ANCESTOR_NOTES = "# Firstmate\n\nAncestor notes that belong to unrelated work.\n";

interface Variant {
  readonly stale?: boolean;
  readonly noContextFiles?: boolean;
  readonly ancestor?: boolean;
  readonly mateNoContextFiles?: boolean;
}

function commitStaleOverview(repo: Scratch): void {
  writeFileSync(join(repo.root, "AGENTS.md"), STALE_OVERVIEW);
  execFileSync("git", ["-C", repo.root, "add", "-A"]);
  execFileSync("git", [
    "-C",
    repo.root,
    "-c",
    "user.name=scratch",
    "-c",
    "user.email=scratch@example.com",
    "commit",
    "-qm",
    "stale overview",
  ]);
}

async function run(t: TestContext, name: string, variant: Variant): Promise<void> {
  const scratch = new Scratch();
  const repo = new Scratch();
  const cardd = await Cardd.start();
  const h = await Harness.start();
  const args = mateArgs(h).filter((arg) => arg !== "--no-builtin-tools");
  const workerArgs = variant.noContextFiles === true ? [...args, "--no-context-files"] : args;
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
    repo.dispose();
    scratch.dispose();
  });
  if (variant.stale === true) commitStaleOverview(repo);
  if (variant.ancestor === true) writeFileSync(join(repo.parent, "AGENTS.md"), ANCESTOR_NOTES);
  const token = cardd.addLane("main", undefined, scratch.root);
  configureMain(scratch, cardd.url, token, { workerArgs });
  cardd.addProject("fleet", { local: repo.root }, undefined, "no-mistakes");
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
        evidence(`${name}-mate`, turns);
        if (dispatched) return { text: "dispatched" };
        dispatched = true;
        return dispatch;
      }
      evidence(`${name}-worker`, turns);
      return { text: "Contributor instructions received." };
    }, "mate");
  const mateStart = variant.mateNoContextFiles === true ? [...args, "--no-context-files"] : args;
  const pane = await startMain(lab, scratch, h, false, mateStart);
  await h.waitFor((event) => event["type"] === "fleet_connected", "the mate to connect");
  await lab.submit(pane, "Inspect contributor prompt routing.");
  const mate = await h.waitForCall(0, "mate", 90_000);
  const worker = await workerCall(h);
  const mateSystem = systemOf(mate);
  assert.match(mateSystem, /^# Firstmate$/m);
  assert.match(mateSystem, /This is the job description of main and every second mate/);
  assert.ok(
    mateSystem.indexOf("# Firstmate") < mateSystem.indexOf("Keep the fixture fleet running"),
  );
  assert.match(mateSystem, /Prefer plain reports/);
  assert.match(mateSystem, /Keep this lane focused/);
  assert.match(mateSystem, /Use the isolated lab/);
  assert.doesNotMatch(mateSystem, /npm run check|fleet\/no-comments|Migrations.*append-only/);
  assert.doesNotMatch(mateSystem, /^# Worker role contract$/m);
  const workerSystem = systemOf(worker);
  assert.match(workerSystem, /^# Worker role contract$/m);
  assert.doesNotMatch(workerSystem, /This is the job description of main and every second mate/);
  assert.doesNotMatch(workerSystem, /Stale overview of the fleet repository/);
  assert.match(workerSystem, /npm run check/);
  assert.match(workerSystem, /fleet\/no-comments/);
  assert.match(workerSystem, /Migrations.*append-only/);
  assert.match(workerSystem, /Do not test by reading source files for strings/);
  assert.doesNotMatch(workerSystem, /Keep the fixture fleet running|Prefer plain reports/);
  if (variant.ancestor === true && variant.noContextFiles !== true)
    assert.match(workerSystem, /Ancestor notes that belong to unrelated work/);
  else {
    assert.doesNotMatch(workerSystem, /Ancestor notes that belong to unrelated work/);
    assert.doesNotMatch(workerSystem, /^# Firstmate$/m);
  }
}

test("a dispatched fleet worker gets CONTRIBUTING.md in place of AGENTS.md while the mate keeps AGENTS.md", async (t) => {
  await run(t, "fresh", {});
});

test("a fleet worker in a worktree that still has the older AGENTS.md overview gets CONTRIBUTING.md", async (t) => {
  await run(t, "stale", { stale: true });
});

test("a fleet worker started without context files gets only CONTRIBUTING.md", async (t) => {
  await run(t, "no-context", { noContextFiles: true, ancestor: true });
});

test("a fleet worker keeps an unrelated ancestor Firstmate file while getting CONTRIBUTING.md", async (t) => {
  await run(t, "ancestor", { ancestor: true });
});

test("a mate started without context files still gets the Firstmate contract", async (t) => {
  await run(t, "mate-no-context", { mateNoContextFiles: true });
});
