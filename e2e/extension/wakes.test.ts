import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { CardViewSchema, check } from "@fleet/protocol";
import { Cardd, type Session } from "../support/cardd.ts";
import { Harness, type Turn } from "../support/harness.ts";
import { HerdrLab } from "../support/herdr.ts";
import { parseRecord } from "../support/json.ts";
import { configureMain, mateArgs, Scratch } from "../support/scratch.ts";

const WAIT_MS = 60_000;
const BIN = fileURLToPath(new URL("../../node_modules/.bin", import.meta.url));
const LANE_CARD = 1;
const MONDAY_EVE = "2026-05-04T08:59:00Z";

const PLAN = {
  goal: "Keep ad spend under the cap. Allowance: spend at most $50 a day, and never change a campaign.",
  timezone: "UTC",
  wakes: [
    { at: "09:00", purpose: "Review ad spend" },
    { at: "09:00", days: ["mon"], purpose: "Write the weekly summary" },
    { at: "17:00", purpose: "Evening look" },
  ],
};

let cardd: Cardd;
let h: Harness;
let lab: HerdrLab;
let here: Scratch;
let main: Session;
let clockFile: string;
let answering = true;

beforeEach(async () => {
  answering = true;
  h = await Harness.start();
  here = new Scratch();
  clockFile = join(here.parent, "clock");
  setClock(MONDAY_EVE);
  cardd = await Cardd.start({ CARDD_TIMING_SCALE: "0.005", CARDD_CLOCK_FILE: clockFile });
  const mainToken = cardd.addLane("main", undefined, here.root);
  configureMain(here, cardd.url, mainToken);
  main = await cardd.connect(mainToken);
  here.addLane("ads", {
    url: cardd.url,
    token: cardd.addLane("ads", "main"),
    args: mateArgs(h),
  });
  lab = await HerdrLab.start({
    ...h.piEnv("mate"),
    PATH: `${BIN}:${process.env["PATH"] ?? ""}`,
    FLEET_SUPERVISE_MS: "1000",
  });
  script();
});
afterEach(async (t) => {
  await lab.printIfFailed(t);
  const stopped = await Promise.allSettled([main.close(), lab.stop(), h.stop(), cardd.stop()]);
  here.dispose();
  const failed = stopped.find((result) => result.status === "rejected");
  if (failed !== undefined) throw new Error(`cleanup failed: ${String(failed.reason)}`);
});

function setClock(iso: string): void {
  const next = `${clockFile}.${randomUUID()}.tmp`;
  writeFileSync(next, iso);
  renameSync(next, clockFile);
}

async function until<T>(
  read: () => T | undefined | Promise<T | undefined>,
  what: string,
): Promise<T> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const idIn = (text: string): string | undefined => /replyTo="(r-\d+)"/.exec(text)?.[1];

function script(): void {
  for (let n = 0; n < 400; n += 1)
    h.onModel((turns) => {
      const said = turns.at(-1)?.role === "user" ? (turns.at(-1)?.text ?? "") : undefined;
      if (said === undefined) return { text: "ok" };
      const id = idIn(said);
      if (answering && said.startsWith("[fleet] scheduled wake") && id !== undefined)
        return { tool: "comment", args: { card: LANE_CARD, text: "Done.", replyTo: id } };
      return { text: "noted" };
    }, "mate");
}

const heard = (pattern: RegExp): string[] => [
  ...new Set(
    h
      .callsOf("mate")
      .flat()
      .filter((turn) => turn.role === "user" && pattern.test(turn.text))
      .map((turn) => turn.text),
  ),
];

const hears = (pattern: RegExp, count = 1): Promise<string[]> =>
  until(() => {
    const found = heard(pattern);
    return found.length >= count ? found : undefined;
  }, `the mate to hear ${pattern.source}`);

const callWith = (text: string): Promise<Turn[]> =>
  until(
    () => h.callsOf("mate").find((turns) => turns.some((turn) => turn.text === text)),
    "the model call that heard it",
  );

const WAKE = /^\[fleet\] scheduled wake/;

const systemOf = (turns: readonly Turn[]): string =>
  turns.find((turn) => turn.role === "system")?.text ?? "";

function setPlan(plan: unknown): void {
  const set = cardd.admin("lane", "plan", "ads", "--plan", JSON.stringify(plan));
  assert.equal(set.status, 0, set.stderr);
}

function shown(): { active: unknown; next: unknown } {
  const out = cardd.admin("lane", "plan", "ads");
  assert.equal(out.status, 0, out.stderr);
  const { active, next } = parseRecord(out.stdout);
  return { active, next };
}

const startMate = (verb: "up" | "restart"): string =>
  here.fleet([verb, "ads"], { HERDR_SESSION: lab.name });

async function mateLoaded(): Promise<void> {
  await until(() => (shown().active === null ? undefined : true), "the mate to load its plan");
}

async function laneThread(): Promise<{ author: string; kind: string; body: string }[]> {
  return (await cardd.thread(LANE_CARD)).entries.map(({ author, kind, body }) => ({
    author,
    kind,
    body,
  }));
}

async function answered(count: number): Promise<void> {
  await until(
    async () => {
      const replies = (await laneThread()).filter(
        (entry) => entry.author === "mate:ads" && entry.body === "Done.",
      );
      const open = (await cardd.board()).cards.find((card) => card.id === LANE_CARD)?.replies;
      return replies.length >= count && open?.length === 0 ? true : undefined;
    },
    `${String(count)} answered wakes`,
  );
}

test("a scheduled wake names its purpose and is answered, and the weekly entry joins only on its day", async () => {
  setPlan(PLAN);
  startMate("up");
  await mateLoaded();

  setClock("2026-05-04T09:00:00Z");
  const [first] = await hears(WAKE);
  const id = idIn(first ?? "") ?? "";
  assert.equal(
    first,
    `[fleet] scheduled wake 2026-05-04T09:00 UTC: Review ad spend; Write the weekly summary (reply owed, ${id}: answer with comment(card=1, text, replyTo="${id}"))`,
  );
  const system = systemOf(await callWith(first));
  assert.match(system, /spend at most \$50 a day, and never change a campaign/);
  assert.match(system, /- every day at 09:00: Review ad spend/);
  assert.match(system, /- every mon at 09:00: Write the weekly summary/);
  assert.match(system, /- every day at 17:00: Evening look/);
  await answered(1);

  setClock("2026-05-05T09:00:00Z");
  const [, second] = await hears(WAKE, 2);
  assert.match(
    second ?? "",
    /^\[fleet\] scheduled wake 2026-05-05T09:00 UTC: Review ad spend; Evening look \[due 2026-05-04T17:00\] \(reply owed, r-\d+:/,
  );
  await answered(2);

  setClock("2026-05-05T17:00:00Z");
  const third = (await hears(WAKE, 3))[2] ?? "";
  assert.match(
    third,
    /^\[fleet\] scheduled wake 2026-05-05T17:00 UTC: Evening look \(reply owed, r-\d+:/,
  );
  await answered(3);

  assert.deepEqual(
    (await cardd.board()).cards.map((card) => card.id),
    [LANE_CARD],
  );
});

test("an unanswered wake is resent and never suppresses later scheduled wakes", async () => {
  answering = false;
  setPlan(PLAN);
  startMate("up");
  await mateLoaded();

  setClock("2026-05-04T09:00:00Z");
  const [wake] = await hears(WAKE);
  const id = idIn(wake ?? "") ?? "";
  const label = "scheduled wake 2026-05-04T09:00 UTC: Review ad spend; Write the weekly summary";
  assert.deepEqual(await hears(/still owed/), [
    `[fleet] check on c-1 ads (finding): reply ${id} is still owed to main: "${label}". Please answer with comment(card=1, text, replyTo="${id}").`,
  ]);
  await until(async () => {
    const reminders = check(
      CardViewSchema,
      await main.call("card", { card: LANE_CARD }),
    ).entries.filter(
      (entry) => entry.fields["reply"] === id && entry.fields["condition"] === "reply-resent",
    );
    return reminders.length >= 3 ? true : undefined;
  }, "three resends of the unanswered wake");

  setClock("2026-05-05T09:00:00Z");
  const second = (await hears(WAKE, 2))[1] ?? "";
  assert.match(second, /^\[fleet\] scheduled wake 2026-05-05T09:00 UTC: Review ad spend/);
  assert.equal(
    (await cardd.board()).cards.find((card) => card.id === LANE_CARD)?.replies.length,
    2,
  );

  await main.call("comment", { lane: "ads", text: "Drop that wake", withdraws: id });
  setClock("2026-05-06T09:00:00Z");
  const woken = (await hears(WAKE, 3))[2] ?? "";
  assert.match(
    woken,
    /^\[fleet\] scheduled wake 2026-05-06T09:00 UTC: Review ad spend; Evening look \[due 2026-05-05T17:00\] \(reply owed, r-\d+:/,
  );
  assert.deepEqual(
    (await cardd.board()).cards.map((card) => card.id),
    [LANE_CARD],
  );
});

test("a changed plan applies after the mate restarts, and a cardd restart repeats no wake", async () => {
  setPlan({
    ...PLAN,
    wakes: [
      { at: "09:00", purpose: "Morning A" },
      { at: "17:00", purpose: "Evening A" },
    ],
  });
  startMate("up");
  await mateLoaded();
  setClock("2026-05-04T09:00:00Z");
  await hears(/Morning A/);
  await answered(1);

  setPlan({ ...PLAN, wakes: [{ at: "09:00", purpose: "Morning B" }] });
  assert.notEqual(shown().next, null);
  setClock("2026-05-05T09:00:00Z");
  await hears(/2026-05-05T09:00 UTC: Morning A/);
  await answered(2);
  assert.deepEqual(heard(/Morning B/), []);

  await cardd.restart();
  setClock("2026-05-05T17:00:00Z");
  const evening = await hears(/2026-05-05T17:00 UTC: Evening A/);
  assert.match(
    evening[0] ?? "",
    /^\[fleet\] scheduled wake 2026-05-05T17:00 UTC: Evening A \(reply owed/,
  );
  await answered(3);

  startMate("restart");
  await until(
    () => (shown().next === null ? true : undefined),
    "the restarted mate to load plan B",
  );
  setClock("2026-05-06T09:00:00Z");
  const morning = await hears(/Morning B/);
  assert.match(
    morning[0] ?? "",
    /^\[fleet\] scheduled wake 2026-05-06T09:00 UTC: Morning B \(reply owed/,
  );
  const latest = systemOf(h.callsOf("mate").at(-1) ?? []);
  assert.match(latest, /- every day at 09:00: Morning B/);
  assert.doesNotMatch(latest, /Morning A|Evening A/);
  assert.equal((await laneThread()).filter((entry) => entry.author === "schedule").length, 4);
});

test("a script wakes the mate with a note, no worker starts, and a bad plan or note is refused", async () => {
  setPlan(PLAN);
  startMate("up");
  await mateLoaded();

  here.fleet(["wake", "ads", "Spend is 40% over the guard cap", "--script", "guard"]);
  assert.deepEqual(await hears(/^\[fleet\] script wake/), [
    "[fleet] script wake guard: Spend is 40% over the guard cap",
  ]);
  assert.deepEqual(
    (await cardd.board()).cards.map((card) => card.id),
    [LANE_CARD],
  );
  assert.deepEqual(await cardd.thread(LANE_CARD).then((thread) => thread.entries.length), 1);

  assert.throws(() => here.fleet(["wake", "ads", "  "]), /note/);
  assert.throws(() => here.fleet(["wake", "nobody", "hello"]), /no lane nobody/);

  const refused = (plan: unknown, lane = "ads"): string => {
    const out = cardd.admin("lane", "plan", lane, "--plan", JSON.stringify(plan));
    assert.notEqual(out.status, 0, out.stdout);
    return out.stderr;
  };
  assert.match(refused({ ...PLAN, allowance: 50 }), /allowance/);
  assert.match(refused({ ...PLAN, timezone: "Mars/Base" }), /time zone/);
  assert.match(refused({ ...PLAN, wakes: [{ at: "25:00", purpose: "x" }] }), /at/);
  assert.match(refused({ ...PLAN, wakes: [{ at: "09:00", purpose: "x".repeat(200) }] }), /purpose/);
  assert.match(refused(PLAN, "main"), /no lane card/);
  assert.equal(shown().next, null);
});
