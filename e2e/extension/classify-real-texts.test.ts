import assert from "node:assert/strict";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { CardViewSchema, check, type Entry } from "@fleet/protocol";
import { begin, newCard, startFleet, type Fleet } from "../support/fleet.ts";
import { Harness } from "../support/harness.ts";
import { tempDir } from "../support/run-root.ts";

const EXTENSION = fileURLToPath(new URL("../../packages/extension/src/index.ts", import.meta.url));

let fleet: Fleet;
let h: Harness;
let clockFile: string;
beforeEach(async () => {
  clockFile = join(tempDir("fleet-clock-"), "clock");
  setClock(Date.now());
  fleet = await startFleet({ CARDD_TIMING_SCALE: "0.02", CARDD_CLOCK_FILE: clockFile });
  h = await Harness.start();
});
afterEach(async () => {
  await h.stop();
  await fleet.cardd.stop();
});

function setClock(ms: number): void {
  const next = `${clockFile}.next`;
  writeFileSync(next, new Date(ms).toISOString());
  renameSync(next, clockFile);
}

const isFailure = (entry: Entry): boolean => entry.fields["condition"] === "runtime-failure";

test("real router exhaustion and payment texts from a failing model turn are classified, with a delay for the cooldown", async () => {
  const texts: [string, string, RegExp][] = [
    [
      "pi-tiers: no usable model for tier 'orchestrator' (anthropic/claude-opus-5-5: cooling, anthropic-2/claude-opus-5-5: cooling, openai-codex/gpt-6.1-sol: cooling, xai/grok-4.7: cooling)",
      "router-cooldown",
      /mode=retry\), eligible at/,
    ],
    [
      "API error (status 402 Payment Required): Grok credits exhausted",
      "vendor-quota",
      /Restarting is not a repair for vendor-quota/,
    ],
  ];
  const names = texts.map((_, index) => ["cleo", "dara"][index] ?? "eli");
  for (const [index, [error]] of texts.entries()) {
    const name = names[index] ?? "";
    const token = fleet.cardd.addLane(name, "main");
    for (let call = 0; call < 3; call += 1) h.onModel(() => ({ fail: error }), name);
    const mate = h.startPi(
      name,
      {
        FLEET_URL: fleet.cardd.url,
        FLEET_TOKEN: token,
        FLEET_ROLE: "mate",
        FLEET_FAKE_AGENT: name,
      },
      [EXTENSION],
    );
    mate.prompt("hello");
  }
  for (const [index, [, kind, next]] of texts.entries()) {
    const name = names[index] ?? "";
    const heard = await fleet.main.waitForEntry(
      (entry) => isFailure(entry) && entry.body.includes(`runtime failure: ${name} `),
      kind,
    );
    assert.match(heard.body, new RegExp(`Classified ${kind}\\.`));
    assert.match(heard.body, next);
  }
});

const SECOND = 1000;
const REAL_EXHAUSTION =
  "pi-tiers: no usable model for tier 'default' (anthropic/claude-sonnet-5-5: cooling, anthropic-2/claude-sonnet-5-5: cooling, openai-codex/gpt-6.1-sol: cooling, xai/grok-4.7: cooling)";

function writeCooldowns(file: string, entries: Record<string, number>): void {
  const dir = join(h.dir, "agent", "tiers", "cooldowns");
  mkdirSync(dir, { recursive: true });
  const body = Object.fromEntries(
    Object.entries(entries).map(([key, untilMs]) => [key, { untilMs, reason: "rate-limit" }]),
  );
  writeFileSync(join(dir, file), JSON.stringify(body));
}

async function laterCheck(): Promise<void> {
  const witness = await newCard(fleet.main, "a later card");
  await begin(fleet.main, witness);
  await fleet.main.waitForEntry(
    (entry) => entry.card === witness.id && entry.fields["condition"] === "worker-never-connected",
    "a check pass",
  );
}

test("a router exhaustion wakes its parent once at the earliest real cooldown expiry, and the parent recovers it on the same card", async () => {
  const base = Date.now();
  const earliest = base + 300 * SECOND;
  writeCooldowns("4101.json", {
    "account:anthropic": earliest,
    "model:anthropic/claude-sonnet-5-5": base + 200 * SECOND,
    "account:anthropic-2": base + 500 * SECOND,
    "model:openai-codex/gpt-6.1-sol": base + 900 * SECOND,
    "model:xai/grok-4.7": base - 60 * SECOND,
  });
  writeCooldowns("4102.json", { "account:anthropic-2": base + 400 * SECOND });
  const dir = join(h.dir, "agent", "tiers", "cooldowns");
  writeFileSync(join(dir, "4103.json"), "{ not json");
  writeFileSync(join(dir, "4104.json"), JSON.stringify({ "account:xai": "tomorrow" }));

  const card = await newCard(fleet.main, "Users see one scrollbar");
  h.onModel(() => ({ fail: REAL_EXHAUSTION }));
  h.onModel(() => ({ tool: "report", args: { status: "note", text: "alive" } }));
  h.onModel(() => ({ text: "recovered" }));
  const token = await begin(fleet.main, card, "the task");
  h.startPi("c-1-a1", { FLEET_URL: fleet.cardd.url, FLEET_TOKEN: token, FLEET_ROLE: "worker" }, [
    EXTENSION,
  ]);
  const heard = await fleet.main.waitForEntry(isFailure, "the exhaustion to reach the parent");

  assert.match(heard.body, /Classified router-cooldown\./);
  assert.ok(
    heard.body.includes(`eligible at ${new Date(earliest).toISOString()}.`),
    `no expiry-derived time: ${heard.body}`,
  );
  const dueNotices = (): Entry[] =>
    fleet.main.entries
      .map((push) => push.entry)
      .filter((entry) => entry.body.includes("is eligible for recovery now"));

  setClock(earliest - SECOND);
  await laterCheck();
  assert.equal(dueNotices().length, 0, "the parent was woken before the earliest expiry");

  setClock(earliest);
  const due = await fleet.main.waitForEntry(
    (entry) => entry.body.includes("is eligible for recovery now"),
    "the wake at the earliest expiry",
  );
  setClock(earliest + SECOND);
  await laterCheck();
  assert.equal(dueNotices().length, 1);

  const [, incident, generation] =
    /Incident (\d+), process generation (\d+)/.exec(heard.body) ?? [];
  await fleet.main.call("card.restart", {
    card: heard.card,
    incident: Number(incident),
    generation: Number(generation),
    mode: "retry",
    key: "mate-retry",
  });
  const done = await fleet.main.waitForEntry(
    (entry) => entry.body.includes("recovered (retry)"),
    "verification",
  );
  assert.equal(done.card, heard.card);
  assert.equal(due.card, heard.card);
  const view = check(CardViewSchema, await fleet.main.call("card", { card: card.id }));
  assert.equal(view.entries.filter((entry) => entry.body.startsWith("runtime failure:")).length, 1);
});
