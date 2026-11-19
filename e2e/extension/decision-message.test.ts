import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { CardSchema, check, OPS } from "@fleet/protocol";
import { Cardd } from "../support/cardd.ts";
import { Harness } from "../support/harness.ts";

const EXTENSION = fileURLToPath(new URL("../../packages/extension/src/index.ts", import.meta.url));

test("a real merge arrival delivers the original chat, reminder and optional walkthrough contract", async () => {
  const cardd = await Cardd.start();
  const token = cardd.addLane("main");
  cardd.addProject("web", { maverick: "/clones/web" }, "acme/web");
  const main = await cardd.connect(token);
  const h = await Harness.start();
  const card = check(
    CardSchema,
    await main.call("card.new", { title: "Release fix", kind: "ship", project: "web" }),
  );
  const attempt = check(
    OPS["attempt.begin"].result,
    await main.call("attempt.begin", { card: card.id, host: "maverick", task: "Fix the release" }),
  );
  const worker = await cardd.connect(attempt.token);
  try {
    h.onModel(() => ({ tool: "yield" }));
    h.startPi("main", { FLEET_URL: cardd.url, FLEET_TOKEN: token, FLEET_ROLE: "mate" }, [
      EXTENSION,
    ]);
    await h.waitFor((event) => event["type"] === "fleet_connected", "main connects");
    await worker.call("report", {
      status: "done",
      text: "Ready",
      pr: "https://github.com/acme/web/pull/7",
    });
    const turns = await h.waitForCall(0);
    assert.match(
      turns.findLast((turn) => turn.role === "user")?.text ?? "",
      /https:\/\/github.com\/acme\/web\/pull\/7/,
    );
    const contract = turns.find((turn) => turn.role === "system")?.text ?? "";
    assert.match(contract, /Tell the captain in chat that the work is ready for review/);
    assert.match(
      contract,
      /When the captain invokes `\/decisions` or asks to go through decisions one by one/,
    );
    assert.match(
      contract,
      /While active, its one-at-a-time presentation replaces the reminder and catch-up decision lists/,
    );
    assert.match(
      contract,
      /bring up one, the way section 8 says: one decision, checked on the live board/,
    );
    assert.match(
      contract,
      /Every chat message he writes you gets a chat reply, never a `yield\(\)`/,
    );
    assert.match(
      contract,
      /Pick only a decision whose hold the board shows still waiting on the captain/,
    );
    assert.match(
      contract,
      /say so in one plain sentence, such as "No decision is waiting on you\."/,
    );
    assert.match(contract, /ask one short clarifying question and nothing else/);
    assert.match(contract, /Still tell him each new outcome once, as it happens/);
    assert.doesNotMatch(contract, /about 80 words|Exactly four interruptions|\/d\b/);
    assert.equal((await cardd.board()).holds.find((hold) => hold.card === card.id)?.merge, true);
  } finally {
    await Promise.allSettled([main.close(), worker.close(), h.stop(), cardd.stop()]);
  }
});
