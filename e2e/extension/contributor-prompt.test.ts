import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { delimiter, join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { Cardd } from "../support/cardd.ts";
import { Harness, type Turn } from "../support/harness.ts";
import { HerdrLab } from "../support/herdr.ts";
import { until } from "../support/live-fleet.ts";
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
const LINK_TARGET_MARKER = "Inert text outside the prompt checkout.";

interface Variant {
  readonly stale?: boolean;
  readonly missingGuide?: boolean;
  readonly linkedGuide?: boolean;
  readonly invalidMateContract?: boolean;
  readonly noContextFiles?: boolean;
  readonly ancestor?: boolean;
  readonly mateNoContextFiles?: boolean;
  readonly mirror?: boolean;
  readonly unrelated?: boolean;
}

function commitFixture(root: string): void {
  execFileSync("git", ["-C", root, "add", "-A"]);
  execFileSync("git", [
    "-C",
    root,
    "-c",
    "user.name=scratch",
    "-c",
    "user.email=scratch@example.com",
    "commit",
    "-qm",
    "worker prompt fixture",
  ]);
}

function prepareProject(scratch: Scratch, repo: Scratch, variant: Variant): string {
  const projectRoot = variant.mirror === true ? join(repo.parent, "mirror-clone") : repo.root;
  if (variant.mirror === true) {
    const mirror = join(repo.parent, "mirror.git");
    execFileSync("git", ["clone", "--quiet", "--mirror", "--", scratch.root, mirror]);
    execFileSync("git", ["clone", "--quiet", "--", mirror, projectRoot]);
  } else if (variant.unrelated === true) {
    execFileSync("git", [
      "-C",
      projectRoot,
      "remote",
      "add",
      "origin",
      "https://github.com/1yian/fleet",
    ]);
  }
  if (variant.stale === true) writeFileSync(join(projectRoot, "AGENTS.md"), STALE_OVERVIEW);
  return projectRoot;
}

function prepareGuide(
  scratch: Scratch,
  repo: Scratch,
  projectRoot: string,
  variant: Variant,
): void {
  const guide = join(projectRoot, "CONTRIBUTING.md");
  const target = join(repo.parent, "prompt-fixture.txt");
  if (variant.invalidMateContract === true || variant.linkedGuide === true)
    writeFileSync(target, LINK_TARGET_MARKER);
  const mateContract = join(scratch.root, "AGENTS.md");
  if (variant.invalidMateContract === true) {
    rmSync(mateContract);
    symlinkSync(target, mateContract);
  }
  if (variant.linkedGuide === true) {
    rmSync(guide);
    symlinkSync(target, guide);
  } else if (variant.missingGuide === true) rmSync(guide);
  else appendFileSync(guide, `\n${WORKER_GUIDE_MARKER}\n`);
  commitFixture(projectRoot);
  writeFileSync(join(scratch.parent, "AGENTS.md"), ANCESTOR_NOTES);
  if (variant.ancestor === true) writeFileSync(join(repo.parent, "AGENTS.md"), ANCESTOR_NOTES);
}

function writeLaneData(scratch: Scratch): void {
  mkdirSync(join(scratch.root, "data"), { recursive: true });
  for (const [file, text] of Object.entries({
    "charter.md": "## Lab charter\n\nKeep the fixture fleet running.\n",
    "captain-shared.md": "Prefer plain reports.\n",
    "captain.md": "Keep this lane focused.\n",
    "learnings.md": "Use the isolated lab.\n",
  }))
    writeFileSync(join(scratch.root, "data", file), text);
}

function assertMateContext(mateSystem: string, scratch: Scratch, mateNoContext: boolean): void {
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
  if (mateNoContext) assert.ok(!mateSystem.includes(ANCESTOR_NOTES.trim()));
  else assert.ok(projectContext.includes(ANCESTOR_NOTES.trim()));
  assert.match(mateSystem, /Prefer plain reports/);
  assert.match(mateSystem, /Keep this lane focused/);
  assert.match(mateSystem, /Use the isolated lab/);
  assert.doesNotMatch(mateSystem, /bun run check|fleet\/no-comments|Migrations.*append-only/);
  assert.doesNotMatch(mateSystem, /^# Worker role contract$/m);
}

function assertGuideContent(guideBlocks: readonly string[], expectedGuides: number): void {
  if (expectedGuides === 0) return;
  const workerGuide = guideBlocks[1]?.split("</project_instructions>")[0] ?? "";
  assert.ok(workerGuide.includes(WORKER_GUIDE_MARKER));
  assert.match(workerGuide, /bun run check/);
  assert.match(workerGuide, /fleet\/no-comments/);
  assert.match(workerGuide, /Migrations.*append-only/);
  assert.match(workerGuide, /Do not test by reading source files for strings/);
}

function assertAncestor(workerSystem: string, variant: Variant): void {
  if (variant.ancestor === true && variant.noContextFiles !== true)
    assert.match(workerSystem, /Ancestor notes that belong to unrelated work/);
  else {
    assert.doesNotMatch(workerSystem, /Ancestor notes that belong to unrelated work/);
    assert.doesNotMatch(workerSystem, /^# Firstmate$/m);
  }
}

async function run(t: TestContext, name: string, variant: Variant): Promise<void> {
  const scratch = new Scratch();
  const repo = new Scratch();
  const cardd = await Cardd.start();
  const h = await Harness.start();
  mkdirSync(join(h.dir, "agent", "extensions"), { recursive: true });
  execFileSync("herdr", ["integration", "install", "pi"], {
    env: { ...process.env, PI_CODING_AGENT_DIR: join(h.dir, "agent") },
  });
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
  const projectRoot = prepareProject(scratch, repo, variant);
  prepareGuide(scratch, repo, projectRoot, variant);
  const token = cardd.addLane("main", undefined, scratch.root);
  configureMain(scratch, cardd.url, token, { workerArgs });
  const project = variant.unrelated === true ? "fleet" : "fleet-tools";
  const identity = variant.unrelated === true ? "acme/site" : "1yian/fleet";
  cardd.addProject(project, { local: projectRoot }, identity, "local-only");
  writeLaneData(scratch);

  const dispatch = {
    tool: "dispatch",
    args: {
      title: "Contributor prompt reaches the worker",
      name: "contributor-prompt",
      kind: "ship",
      project,
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
      if (variant.mirror === true && turns.at(-1)?.role !== "toolResult")
        return { tool: "run_long", args: { label: "wait", command: "sleep 300" } };
      return { text: "Contributor instructions received." };
    }, "mate");
  const mateNoContext = variant.mateNoContextFiles === true;
  const mateStart = mateNoContext ? [...args, "--no-context-files"] : args;
  const pane = await startMain(lab, scratch, h, false, mateStart);
  await h.waitFor((event) => event["type"] === "fleet_connected", "the mate to connect");
  await lab.submit(pane, "Inspect contributor prompt routing.");
  if (variant.invalidMateContract === true) {
    const result = await h.waitFor((event) => event["type"] === "settled", "mate run to settle");
    assert.equal(result["aborted"], true);
    assert.equal(h.callsOf("mate").length, 0);
    const screen = await until(async () => {
      const text = await lab.screen(pane);
      return text.includes("restore a readable regular file at") ? text : undefined;
    }, "the contract error on screen");
    assert.ok(screen.replace(/\s+/g, "").includes(join(realpathSync(scratch.root), "AGENTS.md")));
    return;
  }
  const mate = await h.waitForCall(0, "mate", 90_000);
  const worker = await workerCall(h);
  const tree = realpathSync(`${projectRoot}.worktrees/c-1-a1`);
  assertWorkerGuide(systemOf(worker), tree, variant);
  if (variant.mirror === true) {
    execFileSync("git", ["-C", tree, "mv", ".pi/extensions/fleet.ts", "fleet-renamed.ts"]);
    await lab.submit(pane, restartRequest);
    const replacement = await workerCall(
      h,
      "Your session was restarted on the same card and conversation.",
    );
    assertWorkerGuide(systemOf(replacement), tree, variant);
  }
  assertMateContext(systemOf(mate), scratch, mateNoContext);
}

function assertWorkerGuide(workerSystem: string, tree: string, variant: Variant): void {
  assert.match(workerSystem, /^# Worker role contract$/m);
  if (variant.unrelated === true) {
    assert.ok(workerSystem.includes(`<project_instructions path="${join(tree, "AGENTS.md")}">`));
    assert.match(workerSystem, /This is the job description of main and every second mate/);
    assert.ok(!workerSystem.includes(WORKER_GUIDE_MARKER));
    return;
  }
  assert.doesNotMatch(workerSystem, /This is the job description of main and every second mate/);
  assert.doesNotMatch(workerSystem, /Stale overview of the fleet repository/);
  const workerContext =
    /<project_context>([\s\S]*?)<\/project_context>/.exec(workerSystem)?.[1] ?? "";
  const guideOpen = `<project_instructions path="${join(tree, "CONTRIBUTING.md")}">`;
  const guideBlocks = workerContext.split(guideOpen);
  const expectedGuides = variant.missingGuide === true || variant.linkedGuide === true ? 0 : 1;
  assert.equal(guideBlocks.length - 1, expectedGuides);
  assert.equal(workerSystem.split(WORKER_GUIDE_MARKER).length - 1, expectedGuides);
  assert.ok(!workerSystem.includes(LINK_TARGET_MARKER));
  if (expectedGuides === 0)
    assert.doesNotMatch(workerSystem, /# Contributing to fleet|bun run check/);
  assertGuideContent(guideBlocks, expectedGuides);
  assert.doesNotMatch(workerSystem, /Keep the fixture fleet running|Prefer plain reports/);
  assertAncestor(workerSystem, variant);
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

test("a fleet worker cloned from a bare mirror gets its guide on dispatch and replacement after a staged rename", async (t) => {
  await run(t, "mirror-replacement", { mirror: true });
});

test("a non-fleet registration retains its project context despite a Fleet display name and origin", async (t) => {
  await run(t, "unrelated-registration", { unrelated: true });
});

test("a fleet worker omits a symlinked contributor guide", async (t) => {
  await run(t, "linked-guide", { linkedGuide: true });
});

test("native mate context blocks a run with a symlinked contract", async (t) => {
  await run(t, "linked-native", { invalidMateContract: true });
});

test("mate fallback blocks a run with a symlinked contract", async (t) => {
  await run(t, "linked-fallback", { invalidMateContract: true, mateNoContextFiles: true });
});

test("a mate started without context files still gets the Firstmate contract", async (t) => {
  await run(t, "mate-no-context", { mateNoContextFiles: true });
});
