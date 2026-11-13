import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { CardViewSchema, check, type Card } from "@fleet/protocol";
import { begin, newCard, startFleet } from "../support/fleet.ts";

test("a running tool that keeps producing output is never a stall, and a long turn with no report, commit, or file change is spinning", async () => {
  const fleet = await startFleet({ CARDD_TIMING_SCALE: "0.1" });
  const beats: NodeJS.Timeout[] = [];
  try {
    const quiet = await newCard(fleet.main, "stalls");
    const quietWorker = await fleet.cardd.connect(await begin(fleet.main, quiet));
    quietWorker.send({ t: "activity", state: "running" });
    const spinning = await newCard(fleet.main, "long turn with nothing to show");
    const working = await newCard(fleet.main, "long turn that commits");
    for (const [card, progress] of [
      [spinning, false],
      [working, true],
    ] as const) {
      const worker = await fleet.cardd.connect(await begin(fleet.main, card));
      const send = (): void => {
        worker.send({ t: "activity", state: "running", progress });
      };
      send();
      await worker.call("jobs", {});
      beats.push(setInterval(send, 40));
    }

    const db = new DatabaseSync(fleet.cardd.db, { timeout: 5000 });
    try {
      const past = Date.now() - 61 * 60_000;
      db.prepare(
        "UPDATE sessions SET turn_since = ? WHERE attempt IN (SELECT id FROM attempts WHERE card IN (?, ?))",
      ).run(past, spinning.id, working.id);
      db.prepare(
        "UPDATE sessions SET last_seen = ? WHERE attempt IN (SELECT id FROM attempts WHERE card = ?)",
      ).run(past, quiet.id);
    } finally {
      db.close();
    }

    for (const [card, condition] of [
      [spinning, "worker-spinning"],
      [quiet, "worker-stalled"],
    ] as const) {
      await fleet.main.waitForEntry(
        (entry) => entry.card === card.id && entry.fields["condition"] === condition,
        condition,
      );
    }
    const conditions = async (card: Card): Promise<unknown[]> =>
      check(CardViewSchema, await fleet.main.call("card", { card: card.id }))
        .entries.filter((entry) => entry.kind === "finding" && entry.author === "check")
        .map((entry) => entry.fields["condition"]);
    assert.ok(!(await conditions(spinning)).includes("worker-stalled"));
    const productive = await conditions(working);
    assert.ok(!productive.includes("worker-stalled"));
    assert.ok(!productive.includes("worker-spinning"));
    assert.deepEqual(fleet.cardd.gh.calls(), [], "no wake, report, or close may invoke gh");
  } finally {
    for (const beat of beats) clearInterval(beat);
    await fleet.cardd.stop();
  }
});
