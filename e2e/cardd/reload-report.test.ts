import assert from "node:assert/strict";
import { test } from "node:test";
import { OPS, check } from "@fleet/protocol";
import { Link } from "../../packages/extension/src/link.ts";
import { maintenanceReport, requestAndAwait } from "../../packages/extension/src/maintenance.ts";
import { Cardd } from "../support/cardd.ts";
import { begin, newCard } from "../support/fleet.ts";
import { until } from "../support/live-fleet.ts";

test("the update report keeps what main was told at enrollment about a target whose lane is removed before the batch ends", async () => {
  const cardd = await Cardd.start();
  const mainToken = cardd.addLane("main");
  cardd.addProject("web", { maverick: "/clones/web" }, "acme/web");
  const main = await cardd.connect(mainToken);
  const card = await newCard(main, "verifies");
  const token = await begin(main, card);
  const worker = await cardd.connect(token, [], true, false, true);
  cardd.addLane("never-up", "main");
  const mate = await cardd.connect(cardd.addLane("pending-mate", "main"), [], true, false, true);
  await mate.close();
  await main.close();
  const link = new Link({
    url: cardd.url,
    token: mainToken,
    inFile: () => [],
    onPush: () => undefined,
    onConnect: () => undefined,
    onUnreadable: () => undefined,
    onUnreadableResult: () => undefined,
  });
  link.start();
  try {
    await until(
      async () =>
        (await link.call("board", {}).then(
          () => true,
          () => false,
        ))
          ? true
          : undefined,
      "main's link to connect",
    );
    const batch = "preserved";
    const report = requestAndAwait(link, "reload", batch, 20_000);
    const rows = await until(async () => {
      const found = check(
        OPS["maintenance.status"].result,
        await link.call("maintenance.status", { batch }),
      );
      return found.length === 3 ? found : undefined;
    }, "the batch to be enrolled");
    const own = rows.find((row) => row.session === `c-${String(card.id)}-a1`);
    assert.ok(own);
    for (const lane of ["never-up", "pending-mate"]) {
      const removed = cardd.admin("lane", "remove", lane);
      assert.equal(removed.status, 0, removed.stderr);
    }
    const replacement = await cardd.replace(worker, token, own.id);
    const lines = maintenanceReport(await report);
    await replacement.close();
    assert.ok(
      lines.some(
        (line) => line.includes(`c-${String(card.id)}-a1`) && line.includes("reload completed"),
      ),
    );
    assert.ok(
      lines.some((line) =>
        /^- never-up \(mate\): reload failed - not connected .* \[c-\d+, host unknown, process unknown\]$/.test(
          line,
        ),
      ),
      lines.join("\n"),
    );
    assert.ok(
      lines.some((line) => line.startsWith("- pending-mate (mate): reload pending - ")),
      lines.join("\n"),
    );
    assert.equal(
      lines.some((line) => line.includes("reload completed") && line.includes("pending-mate")),
      false,
    );
    assert.equal(cardd.summaryCount(), 1);
  } finally {
    link.stop();
    await cardd.stop();
  }
});
