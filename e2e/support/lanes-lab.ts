import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach } from "node:test";
import { Cardd, type Session } from "./cardd.ts";
import { Harness, type Turn } from "./harness.ts";
import { HerdrLab } from "./herdr.ts";
import { isRecord, records, type JsonRecord } from "./json.ts";
import { configureMain, mateArgs, Scratch } from "./scratch.ts";

const WAIT_MS = 60_000;
const BIN = fileURLToPath(new URL("../../node_modules/.bin", import.meta.url));
const TRANSPORT = fileURLToPath(new URL("../support/switch-transport.ts", import.meta.url));
const TORN = fileURLToPath(new URL("../support/torn-lane-transport.ts", import.meta.url));

let cardd: Cardd;
let h: Harness;
let lab: HerdrLab;
let here: Scratch;
let p620: Scratch;
let ghost: Session;
let marker: string;
let mainToken: string;
beforeEach(async () => {
  cardd = await Cardd.start();
  h = await Harness.start();
  here = new Scratch();
  p620 = new Scratch();
  marker = join(here.parent, "p620-down");
  mainToken = cardd.addLane("main", undefined, here.root);
  configureMain(here, cardd.url, mainToken, {
    hosts: { p620: ["node", TRANSPORT, marker] },
    roots: { p620: p620.root },
  });
  const settings = (lane: string) => ({
    url: cardd.url,
    token: cardd.addLane(lane, "main"),
    args: mateArgs(h),
  });
  here.addLane("ops", settings("ops"));
  p620.addLane("far", settings("far"));
  ghost = await cardd.connect(cardd.addLane("ghost", "main"));
  lab = await HerdrLab.start({
    ...h.piEnv("mate"),
    DIRENV_CONFIG: join(here.parent, "direnv"),
    PATH: `${BIN}:${process.env["PATH"] ?? ""}`,
    FLEET_SUPERVISE_MS: "1000",
  });
});
afterEach(async (t) => {
  await lab.printIfFailed(t);
  const stopped = await Promise.allSettled([ghost.close(), lab.stop(), h.stop(), cardd.stop()]);
  here.dispose();
  p620.dispose();
  const failed = stopped.find((result) => result.status === "rejected");
  if (failed !== undefined) throw new Error(`cleanup failed: ${String(failed.reason)}`);
});

async function until<T>(
  read: () => T | undefined | Promise<T | undefined>,
  what: string,
  detail?: () => string | Promise<string>,
  progress?: () => unknown,
): Promise<T> {
  let deadline = Date.now() + WAIT_MS;
  let advanced = progress?.();
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    const now = progress?.();
    if (now !== advanced) {
      advanced = now;
      deadline = Date.now() + WAIT_MS;
    }
    if (Date.now() > deadline) {
      const why = await Promise.resolve()
        .then(() => detail?.() ?? "")
        .catch((error: unknown) => `no detail: ${String(error)}`);
      assert.fail(`timed out waiting for ${what}\n${why}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

function rowsOf(host: Scratch, args: readonly string[]): JsonRecord[] {
  const parsed: unknown = JSON.parse(host.fleet([...args, "--json"], { HERDR_SESSION: lab.name }));
  return Array.isArray(parsed) ? parsed.filter(isRecord) : [];
}

const states = (host: Scratch): Record<string, string> =>
  Object.fromEntries(
    rowsOf(host, ["status"]).map((row) => [String(row["lane"]), String(row["state"])]),
  );
const waitState = (host: Scratch, lane: string, state: string) =>
  until(
    () => (states(host)[lane] === state ? true : undefined),
    `${lane} to be ${state}`,
    async () => {
      const workspaces = records((await lab.run(["workspace", "list"]))["workspaces"]);
      const workspace = workspaces.find((each) => each["label"] === `2ndmate-${lane}`);
      const listed = await lab.run([
        "pane",
        "list",
        "--workspace",
        String(workspace?.["workspace_id"]),
      ]);
      const pane = String(records(listed["panes"])[0]?.["pane_id"]);
      const info = JSON.stringify(
        (await lab.run(["pane", "process-info", "--pane", pane]))["process_info"],
      );
      return `status: ${JSON.stringify(states(host))}\nprocesses: ${info}\nscreen:\n${await lab.screen(pane)}`;
    },
  );

async function paneInfo(lane: string): Promise<JsonRecord[]> {
  const workspaces = records((await lab.run(["workspace", "list"]))["workspaces"]);
  const workspace = workspaces.find((each) => each["label"] === `2ndmate-${lane}`);
  const listed = await lab.run([
    "pane",
    "list",
    "--workspace",
    String(workspace?.["workspace_id"]),
  ]);
  const pane = String(records(listed["panes"])[0]?.["pane_id"]);
  return records([(await lab.run(["pane", "process-info", "--pane", pane]))["process_info"]]);
}

async function groupOf(lane: string): Promise<number> {
  return Number((await paneInfo(lane))[0]?.["foreground_process_group_id"]);
}

const waitPi = (lane: string) =>
  until(async () => {
    const processes = records((await paneInfo(lane))[0]?.["foreground_processes"]);
    return processes.some((each) => each["name"] === "pi" || each["argv0"] === "pi")
      ? true
      : undefined;
  }, `${lane} to run Pi`);

const sessionText = (): string =>
  readdirSync(join(h.dir, "sessions"))
    .map((file) => readFileSync(join(h.dir, "sessions", file), "utf8"))
    .join("\n");

async function wakeMain(title: string): Promise<void> {
  const card: unknown = await ghost.call("card.new", { title, kind: "scout" });
  const id: unknown = Reflect.get(Object(card), "id");
  await ghost.call("hold", {
    card: id,
    question: `${title}?`,
    options: ["Yes"],
  });
}

const users = (turns: Turn[]): string =>
  turns
    .filter((turn) => turn.role === "user")
    .map((turn) => turn.text)
    .join("\n");

export {
  WAIT_MS,
  TRANSPORT,
  TORN,
  cardd,
  h,
  lab,
  here,
  p620,
  marker,
  mainToken,
  until,
  rowsOf,
  states,
  waitState,
  paneInfo,
  groupOf,
  waitPi,
  sessionText,
  wakeMain,
  users,
};
