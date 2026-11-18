import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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

async function workerCall(h: Harness, message?: string): Promise<Turn[]> {
  for (let call = 0; ; call += 1) {
    const turns = await h.waitForCall(call, "mate", 90_000);
    if (
      systemOf(turns).includes("# Worker role contract") &&
      (message === undefined ||
        turns.some((turn) => turn.role === "user" && turn.text.includes(message)))
    )
      return turns;
  }
}

const STALE_OVERVIEW = "# fleet\n\nStale overview of the fleet repository.\n";
const ANCESTOR_NOTES = "# Firstmate\n\nAncestor notes that belong to unrelated work.\n";
const WORKER_GUIDE_MARKER = "Use the worker checkout's fixture checklist.";

interface Variant {
  readonly stale?: boolean;
  readonly missingGuide?: boolean;
  readonly noContextFiles?: boolean;
  readonly ancestor?: boolean;
  readonly mateNoContextFiles?: boolean;
  readonly restartAfterRename?: boolean;
}

function commitFixture(repo: Scratch): void {
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
    "worker prompt fixture",
  ]);
}

async function run(t: TestContext, name: string, variant: Variant): Promise<void> {
  const scratch = new Scratch();
  const repo = new Scratch();
  const cardd = await Cardd.start();
  const h = await Harness.start();
  const args = mateArgs(h).filter(
    (arg) => arg !== "--no-builtin-tools" && arg !== "--no-context-files",
  );
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
  if (variant.stale === true) writeFileSync(join(repo.root, "AGENTS.md"), STALE_OVERVIEW);
  const guide = join(repo.root, "CONTRIBUTING.md");
  if (variant.missingGuide === true) rmSync(guide);
  else appendFileSync(guide, `\n${WORKER_GUIDE_MARKER}\n`);
  commitFixture(repo);
  writeFileSync(join(scratch.parent, "AGENTS.md"), ANCESTOR_NOTES);
  if (variant.ancestor === true) writeFileSync(join(repo.parent, "AGENTS.md"), ANCESTOR_NOTES);
  const token = cardd.addLane("main", undefined, scratch.root);
  configureMain(scratch, cardd.url, token, { workerArgs });
  execFileSync("git", [
    "-C",
    repo.root,
    "remote",
    "add",
    "origin",
    "https://github.com/1yian/fleet",
  ]);
  cardd.addProject("fleet", { local: repo.root }, undefined, "local-only");
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
      kind: "ship",
      project: "fleet",
      intent: "Inspect contributor instructions",
      task: "Inspect your repository instructions without changing files.",
      host: "local",
    },
  } as const;
  const restartRequest = "Restart the worker in its existing worktree.";
  let dispatched = false;
  for (let call = 0; call < 20; call += 1)
    h.onModel((turns) => {
      if (!systemOf(turns).includes("# Worker role contract")) {
        evidence(`${name}-mate`, turns);
        if (turns.at(-1)?.role === "user" && turns.at(-1)?.text === restartRequest)
          return { tool: "restart_card", args: { card: 1, mode: "replace" } };
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
  let worker = await workerCall(h);
  const tree = realpathSync(`${repo.root}.worktrees/c-1-a1`);
  if (variant.restartAfterRename === true) {
    execFileSync("git", ["-C", tree, "mv", ".pi/extensions/fleet.ts", "fleet-renamed.ts"]);
    await lab.submit(pane, restartRequest);
    worker = await workerCall(h, "Your session was restarted on the same card and conversation.");
  }
  const mateSystem = systemOf(mate);
  const projectContext =
    /<project_context>([\s\S]*?)<\/project_context>/.exec(mateSystem)?.[1] ?? "";
  const homeOpen = `<project_instructions path="${join(realpathSync(scratch.root), "AGENTS.md")}">`;
  const homeBlocks = projectContext.split(homeOpen);
  assert.equal(homeBlocks.length, 2);
  const homeContract = homeBlocks[1]?.split("</project_instructions>")[0] ?? "";
  assert.match(homeContract, /^# Firstmate$/m);
  const jobDescription = /This is the job description of main and every second mate/g;
  assert.match(homeContract, jobDescription);
  assert.equal([...mateSystem.matchAll(jobDescription)].length, 1);
  assert.ok(mateSystem.indexOf(homeOpen) < mateSystem.indexOf("Keep the fixture fleet running"));
  if (variant.mateNoContextFiles === true) assert.ok(!mateSystem.includes(ANCESTOR_NOTES.trim()));
  else assert.ok(projectContext.includes(ANCESTOR_NOTES.trim()));
  assert.match(mateSystem, /Prefer plain reports/);
  assert.match(mateSystem, /Keep this lane focused/);
  assert.match(mateSystem, /Use the isolated lab/);
  assert.doesNotMatch(mateSystem, /npm run check|fleet\/no-comments|Migrations.*append-only/);
  assert.doesNotMatch(mateSystem, /^# Worker role contract$/m);
  const workerSystem = systemOf(worker);
  assert.match(workerSystem, /^# Worker role contract$/m);
  assert.doesNotMatch(workerSystem, /This is the job description of main and every second mate/);
  assert.doesNotMatch(workerSystem, /Stale overview of the fleet repository/);
  const workerContext =
    /<project_context>([\s\S]*?)<\/project_context>/.exec(workerSystem)?.[1] ?? "";
  const guideOpen = `<project_instructions path="${join(tree, "CONTRIBUTING.md")}">`;
  const guideBlocks = workerContext.split(guideOpen);
  const expectedGuides = variant.missingGuide === true ? 0 : 1;
  assert.equal(guideBlocks.length - 1, expectedGuides);
  assert.equal(workerSystem.split(WORKER_GUIDE_MARKER).length - 1, expectedGuides);
  if (variant.missingGuide === true) {
    assert.doesNotMatch(workerSystem, /# Contributing to fleet|npm run check/);
  } else {
    const workerGuide = guideBlocks[1]?.split("</project_instructions>")[0] ?? "";
    assert.ok(workerGuide.includes(WORKER_GUIDE_MARKER));
    assert.match(workerGuide, /npm run check/);
    assert.match(workerGuide, /fleet\/no-comments/);
    assert.match(workerGuide, /Migrations.*append-only/);
    assert.match(workerGuide, /Do not test by reading source files for strings/);
  }
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

test("a fleet worker without a contributor guide keeps unrelated context but not the mate contract", async (t) => {
  await run(t, "missing-guide", { missingGuide: true, ancestor: true });
});

test("a restarted fleet worker keeps its own guide after a staged extension rename", async (t) => {
  await run(t, "restart-after-rename", { restartAfterRename: true });
});

test("a mate started without context files still gets the Firstmate contract", async (t) => {
  await run(t, "mate-no-context", { mateNoContextFiles: true });
});
