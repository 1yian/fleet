import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { check, OPS } from "@fleet/protocol";
import { ageDelivery, MINUTE, newCard, startFleet, type Fleet } from "../support/fleet.ts";
import { assign, receipt, TOKEN, tool, VERSION, view } from "../support/grok.ts";

let fleet: Fleet | undefined;
afterEach(async () => fleet?.cardd.stop());

test("the connector refuses a standalone stream, batches, bad JSON and oversized bodies without recording", async () => {
  const started = await startFleet({ CARDD_GROK_REPORT_TOKEN: TOKEN });
  fleet = started;
  const card = await newCard(started.main, "Refuse unsupported requests");
  const assignment = await assign(started, card);
  const url = started.cardd.url.replace(/^ws/, "http").replace(/\/session$/, "/grok-report/mcp");
  const post = (body: string | Uint8Array<ArrayBuffer>) =>
    fetch(url, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": VERSION,
        authorization: `Bearer ${TOKEN}`,
      },
      body,
    });
  const call = (text: string) => ({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "fleet_report_result",
      arguments: { ...assignment, text, sources: ["https://example.test/one"] },
    },
  });
  for (const method of ["GET", "DELETE"]) {
    const refused = await fetch(url, {
      method,
      headers: {
        accept: "text/event-stream",
        authorization: `Bearer ${TOKEN}`,
      },
    });
    assert.equal(refused.status, 405);
    assert.equal(refused.headers.get("allow"), "POST");
    assert.partialDeepStrictEqual(await refused.json(), {
      jsonrpc: "2.0",
      error: { code: -32000 },
    });
  }
  const batch = await post(JSON.stringify([call("first"), call("second")]));
  assert.equal(batch.status, 400);
  assert.partialDeepStrictEqual(await batch.json(), {
    jsonrpc: "2.0",
    error: { code: -32600 },
  });
  const malformed = await post("{not json");
  assert.equal(malformed.status, 400);
  assert.partialDeepStrictEqual(await malformed.json(), {
    jsonrpc: "2.0",
    error: { code: -32700 },
  });
  const [head = "", tail = ""] = JSON.stringify(call("bad|evidence")).split("|");
  const invalidUtf8 = new Uint8Array(
    Buffer.concat([Buffer.from(head), Buffer.from([0xff]), Buffer.from(tail)]),
  );
  const garbled = await post(invalidUtf8);
  assert.equal(garbled.status, 400);
  assert.partialDeepStrictEqual(await garbled.json(), {
    jsonrpc: "2.0",
    error: { code: -32700 },
  });
  const large = await post(JSON.stringify(call("x".repeat(200 * 1024))));
  assert.equal(large.status, 413);
  assert.partialDeepStrictEqual(await large.json(), {
    jsonrpc: "2.0",
    error: { code: -32000 },
  });
  assert.deepEqual(
    (await view(started, card)).entries.filter((entry) => entry.author === "grok-bot"),
    [],
  );
  const single = await post(JSON.stringify(call("only")));
  assert.equal(single.status, 200);
  const pushed = await started.main.waitForEntry(
    (entry) => entry.author === "grok-bot" && entry.card === card.id,
    "the single result",
  );
  assert.equal(pushed.body, "only");
});

test("a second mate's Grok result stays out of the board, summaries and other lanes", async () => {
  const started = await startFleet({ CARDD_GROK_REPORT_TOKEN: TOKEN });
  fleet = started;
  const cleo = await started.cardd.connect(started.cardd.addLane("cleo", "main"));
  const card = await newCard(cleo, "Check the internal source");
  const assignment = check(
    OPS["grok.assign"].result,
    await cleo.call("grok.assign", { card: card.id }),
  );
  const secret = "Internal excerpt: the vendor price is 41 percent below list.";
  const permalink = "https://chat.example.test/archives/C1/p1700000000";
  const accepted = await tool(started, {
    ...assignment,
    text: secret,
    sources: [permalink],
  });
  const pushed = await cleo.waitForEntry(
    (entry) => entry.author === "grok-bot" && entry.card === card.id,
    "the Grok Bot result in the owning mate's inbox",
  );
  assert.deepEqual(accepted, receipt("recorded", pushed.id));
  assert.equal(pushed.body, secret);
  const ownView = check(OPS.card.result, await cleo.call("card", { card: card.id }));
  assert.deepEqual(
    ownView.entries.filter((entry) => entry.author === "grok-bot"),
    [pushed],
  );
  const mainView = await view(started, card);
  assert.deepEqual(
    mainView.entries.filter((entry) => entry.author === "grok-bot"),
    [],
  );
  const everywhere = JSON.stringify([
    mainView,
    await started.cardd.board(),
    await started.cardd.thread(card.id),
    check(OPS.board.result, await started.main.call("board", {})),
  ]);
  assert.ok(!everywhere.includes(secret));
  assert.ok(!everywhere.includes(permalink));
  assert.ok(
    !JSON.stringify(check(OPS.board.result, await cleo.call("board", {}))).includes(secret),
  );
});

test("main hears that a second mate left a Grok result unread without its text or sources", async () => {
  const started = await startFleet({
    CARDD_GROK_REPORT_TOKEN: TOKEN,
    CARDD_CHECK_EVERY_MS: "50",
  });
  fleet = started;
  const cleo = await started.cardd.connect(started.cardd.addLane("cleo", "main"), [], false);
  const card = await newCard(cleo, "Check the private channel");
  const assignment = check(
    OPS["grok.assign"].result,
    await cleo.call("grok.assign", { card: card.id }),
  );
  const secret = "Private excerpt: the contract renews at 12 percent.";
  const permalink = "https://chat.example.test/archives/C2/p1700000001";
  await tool(started, { ...assignment, text: secret, sources: [permalink] });
  const result = await cleo.waitForEntry(
    (entry) => entry.author === "grok-bot",
    "the result in the owning mate's inbox",
  );
  for (const resend of [1, 2, 3]) {
    ageDelivery(started.cardd, "cleo", result.id, "updated_at", 3 * MINUTE);
    await cleo.waitForEntries(1 + resend);
  }
  const missed = await started.main.waitForEntry(
    (entry) => entry.fields["condition"] === "missed" && entry.fields["entry"] === result.id,
    "main to hear that cleo left the result unread",
  );
  assert.ok(!JSON.stringify(missed).includes(secret));
  assert.ok(!JSON.stringify(missed).includes(permalink));
  assert.ok(
    cleo.entries.slice(1).every(({ entry, again }) => entry.body === secret && again === true),
  );
});
