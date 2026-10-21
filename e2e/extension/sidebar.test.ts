import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { Cardd } from "../support/cardd.ts";
import { Harness } from "../support/harness.ts";
import { HerdrLab } from "../support/herdr.ts";
import { optionalString, records } from "../support/json.ts";
import { addRemote, git, landOnRemote } from "../support/remote.ts";
import { configureMain, mateArgs, Scratch, startMain } from "../support/scratch.ts";

const WAIT_MS = 120_000;
const BIN = fileURLToPath(new URL("../../node_modules/.bin", import.meta.url));
const TRANSPORT = fileURLToPath(new URL("../support/switch-transport.ts", import.meta.url));

let cardd: Cardd;
let h: Harness;
let lab: HerdrLab;
let here: Scratch;
let p620: Scratch;
let tokens: Record<string, string>;
let sites: string;
beforeEach(async () => {
  h = await Harness.start();
  here = new Scratch();
  const remote = addRemote(here.root);
  p620 = new Scratch("fleet");
  git(p620.root, "remote", "add", "origin", remote);
  git(p620.root, "fetch", "-q", "origin");
  git(p620.root, "reset", "-q", "--hard", "origin/main");
  cardd = await Cardd.start();
  const marker = join(here.parent, "p620-down");
  const mainToken = cardd.addLane("main", undefined, here.root);
  configureMain(here, cardd.url, mainToken, {
    hosts: { p620: ["node", TRANSPORT, marker] },
    roots: { p620: p620.root },
  });
  tokens = { main: mainToken };
  for (const lane of ["ops", "far"]) {
    tokens[lane] = cardd.addLane(lane, "main");
    const settings = { url: cardd.url, token: tokens[lane] ?? "", args: mateArgs(h) };
    (lane === "ops" ? here : p620).addLane(lane, settings);
  }
  sites = join(here.parent, "site.worktrees");
  lab = await HerdrLab.start({
    ...h.piEnv("mate"),
    PATH: `${BIN}:${process.env["PATH"] ?? ""}`,
    FLEET_SUPERVISE_MS: "1000",
  });
  landOnRemote(remote, "fleet-fix");
});
afterEach(async (t) => {
  await lab.printIfFailed(t);
  const stopped = await Promise.allSettled([lab.stop(), h.stop(), cardd.stop()]);
  here.dispose();
  p620.dispose();
  const failed = stopped.find((result) => result.status === "rejected");
  if (failed !== undefined) throw new Error(`cleanup failed: ${String(failed.reason)}`);
});

async function until<T>(
  read: () => T | undefined | Promise<T | undefined>,
  what: string,
  detail: () => Promise<string>,
): Promise<T> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}\n${await detail()}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

const sidebar = async (): Promise<string[]> =>
  records((await lab.run(["workspace", "list"]))["workspaces"]).map((each) =>
    String(each["label"]),
  );

async function untilSidebar(expected: readonly string[]): Promise<void> {
  await until(
    async () => ((await sidebar()).join("\n") === expected.join("\n") ? true : undefined),
    `the sidebar to read ${JSON.stringify(expected)}`,
    async () => `the sidebar reads ${JSON.stringify(await sidebar())}`,
  );
}

async function runsPi(label: string): Promise<boolean> {
  const workspaces = records((await lab.run(["workspace", "list"]))["workspaces"]);
  const id = optionalString(
    workspaces.find((each) => each["label"] === label) ?? {},
    "workspace_id",
  );
  if (id === undefined) return false;
  const panes = records((await lab.run(["pane", "list", "--workspace", id]))["panes"]);
  const info = await lab.run(["pane", "process-info", "--pane", String(panes[0]?.["pane_id"])]);
  return records(records([info["process_info"]])[0]?.["foreground_processes"]).some(
    (each) => each["name"] === "pi" || each["argv0"] === "pi",
  );
}

async function allRunPi(): Promise<void> {
  await until(
    async () => {
      const running = await Promise.all(["1stmate", "2ndmate-ops", "2ndmate-far"].map(runsPi));
      return running.every(Boolean) ? true : undefined;
    },
    "main, ops, and far to run Pi",
    async () => `the sidebar reads ${JSON.stringify(await sidebar())}`,
  );
}

async function newCard(lane: string, name: string): Promise<number> {
  const made = await cardd.post(tokens[lane] ?? "", "card.new", {
    title: name,
    name,
    kind: "scout",
  });
  assert.equal(made.status, 200);
  const card = (await cardd.board()).cards.find((each) => each.name === name);
  assert.ok(card !== undefined);
  return card.id;
}

const WORKERS = [
  ["far", "far-one"],
  ["ops", "ops-alpha"],
  ["main", "main-one"],
  ["ops", "ops-beta"],
] as const;

const GROUPED = [
  "~",
  "1stmate",
  "└ main-one",
  "2ndmate-far",
  "└ far-one",
  "2ndmate-ops",
  "└ ops-alpha",
  "└ ops-beta",
];

async function openWorker(name: string, card: number): Promise<string> {
  const cwd = join(sites, `c-${String(card)}-a1`);
  mkdirSync(cwd, { recursive: true });
  const made = await lab.run(["workspace", "create", "--cwd", cwd, "--label", name, "--no-focus"]);
  return String(records([made["workspace"]])[0]?.["workspace_id"]);
}

test("/updatefleet leaves each mate's workspace followed by its own workers, whatever order the restarts and the workers' creation left", async () => {
  await lab.run(["workspace", "create", "--cwd", here.root, "--label", "~", "--no-focus"]);
  const pane = await startMain(lab, here, h);
  await allRunPi();
  const cards = new Map<string, number>();
  for (const [lane, name] of WORKERS) cards.set(name, await newCard(lane, name));
  for (const [, name] of [...WORKERS].reverse()) await openWorker(name, cards.get(name) ?? 0);
  const before = await sidebar();
  assert.notDeepEqual(before, GROUPED);
  process.stderr.write(`sidebar before the update: ${JSON.stringify(before)}\n`);

  await lab.submit(pane, "/updatefleet");
  await until(
    () => {
      const sessions = join(h.dir, "sessions");
      const text = readdirSync(sessions).map((file) => readFileSync(join(sessions, file), "utf8"));
      return text.join("\n").includes("[fleet] update: Fleet updated.") ? true : undefined;
    },
    "main to record the update's report",
    async () => `the sidebar reads ${JSON.stringify(await sidebar())}`,
  );
  await untilSidebar(GROUPED);
  await allRunPi();
  process.stderr.write(`sidebar after the update: ${JSON.stringify(await sidebar())}\n`);
});

test("restarting one lane on its own puts its workspace back above its workers", async () => {
  await lab.run(["workspace", "create", "--cwd", here.root, "--label", "~", "--no-focus"]);
  await startMain(lab, here, h);
  await allRunPi();
  for (const [lane, name] of WORKERS) {
    const card = await newCard(lane, name);
    const workspace = await openWorker(name, card);
    const mark = [
      "--source",
      "fleet",
      "--token",
      `lane=${lane}`,
      "--token",
      `card=${String(card)}`,
    ];
    await lab.run(["workspace", "report-metadata", workspace, ...mark]);
  }
  here.fleet(["arrange"], { HERDR_SESSION: lab.name });
  await untilSidebar(GROUPED);

  here.fleet(["restart", "ops"], { HERDR_SESSION: lab.name });
  await untilSidebar(GROUPED);
  await allRunPi();
});
