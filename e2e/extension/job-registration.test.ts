import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { CardViewSchema, check, HttpCallSchema, HttpOutcomeSchema, OPS } from "@fleet/protocol";
import { quote } from "@fleet/protocol/route";
import { begin, MINUTE, newCard, startFleet } from "../support/fleet.ts";
import { spawnGuarded } from "../support/guarded.ts";
import { HerdrLab } from "../support/herdr.ts";
import { until } from "../support/live-fleet.ts";
import { tempDir } from "../support/run-root.ts";

const WRAPPER = fileURLToPath(new URL("../../packages/extension/src/job.ts", import.meta.url));

test("a prepared wrapper does not run Bash until a complete registration receipt arrives", async (t) => {
  const { main, cardd } = await startFleet({ CARDD_TIMING_SCALE: "0.025" });
  t.after(() => cardd.stop());
  const card = await newCard(main, "Prove the startup receipt");
  const token = await begin(main, card);
  const lab = await HerdrLab.start({});
  t.after(() => lab.stop());
  const dir = tempDir("registration-");
  const permit = Promise.withResolvers<void>();
  const seen: { job: number; launch: string; pid: number }[] = [];
  let mode: "retry" | "always-torn" = "retry";
  const proxy = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8").on("data", (chunk: string) => {
      body += chunk;
    });
    req.on("end", () => {
      void (async () => {
        const { op, args } = check(HttpCallSchema, JSON.parse(body));
        const result = await cardd.post(token, op, args);
        res.writeHead(result.status, { "content-type": "application/json" });
        if (op === "job.register") {
          seen.push(check(OPS["job.register"].args, args));
          if (mode === "always-torn" || seen.length === 1) {
            res.end('{"ok":true,"value":{} }');
            return;
          }
          await permit.promise;
        }
        res.end(JSON.stringify(result.body));
      })().catch((error: unknown) => res.destroy(error instanceof Error ? error : undefined));
    });
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  t.after(() => {
    permit.resolve();
    proxy.closeAllConnections();
    proxy.close();
  });
  const address = proxy.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${String(address.port)}/call`;

  const start = async (label: string) => {
    const launch = randomUUID();
    const marker = join(dir, label);
    const command = `printf 'ran\\n' >> ${quote(marker)}; echo ${label}`;
    const response = await cardd.post(token, "job.prepare", { label, command, launch });
    const outcome = check(HttpOutcomeSchema, response.body);
    assert.ok(outcome.ok);
    const prepared = check(OPS["job.prepare"].result, outcome.value);
    assert.ok("heartbeatMs" in prepared);
    const { job, heartbeatMs } = prepared;
    const file = join(dir, `fleet-job-${String(job)}-${launch}.json`);
    writeFileSync(
      file,
      JSON.stringify({
        url,
        token,
        job,
        heartbeatMs,
        timeoutMs: 20000,
        launch: { id: launch, command },
      }),
      { mode: 0o600 },
    );
    const child = spawnGuarded(process.execPath, [WRAPPER, file], {
      env: { ...process.env, ...lab.owned, HERDR_TAB_ID: undefined },
      stdio: ["ignore", "inherit", "inherit"],
    });
    return { job, marker, exited: once(child, "exit") };
  };

  const worker = await cardd.connect(token);
  const silent = async (label: string): Promise<number> =>
    check(OPS["job.start"].result, await worker.call("job.start", { label, command: "true" })).job;
  const lost = await silent("unconfirmed");
  const control = await silent("control");
  for (const job of [lost, control])
    await main.waitForEntry(
      (entry) =>
        entry.card === card.id &&
        entry.fields["condition"] === "job-lost" &&
        entry.fields["job"] === job,
      `job ${String(job)} to be lost before the retries`,
    );

  await worker.call("report", { status: "working", text: "Checking wrapper startup receipts." });
  const first = await start("received");
  await until(() => (seen.length === 2 ? true : undefined), "the second registration request");
  assert.equal(seen[0]?.job, first.job);
  assert.deepEqual(seen[0], seen[1]);
  assert.equal(existsSync(first.marker), false);
  const identity = seen[0];
  assert.ok(identity);
  const conflicting = await cardd.post(token, "job.register", {
    ...identity,
    pid: identity.pid + 1,
  });
  assert.deepEqual(conflicting.body, { ok: true, value: { registered: false } });
  const lateLaunchError = await cardd.post(token, "job.finish", {
    job: first.job,
    beforeRegistration: identity.launch,
    exitCode: 127,
    outputTail: "ambiguous pane result",
  });
  assert.deepEqual(lateLaunchError.body, { ok: true, value: { recorded: false } });
  const receiptControl = await silent("receipt-window-control");
  await main.waitForEntry(
    (entry) => entry.fields["condition"] === "job-lost" && entry.fields["job"] === receiptControl,
    "the detector to report a job admitted after registration while the receipt is held",
  );
  assert.deepEqual(await worker.call("jobs", {}), [{ id: first.job, label: "received" }]);
  assert.equal(existsSync(first.marker), false);
  permit.resolve();
  assert.deepEqual(await first.exited, [0, null]);
  assert.equal(readFileSync(first.marker, "utf8"), "ran\n");
  assert.equal(seen.filter(({ job }) => job === first.job).length, 2);
  const afterReceipt = check(CardViewSchema, await main.call("card", { card: card.id }));
  assert.deepEqual(
    afterReceipt.entries
      .filter((entry) => entry.fields["job"] === first.job)
      .map((entry) => [entry.kind, entry.fields["exitCode"], entry.body]),
    [["job-result", 0, "received"]],
  );

  const movedAt = async () => {
    const pulse = check(OPS.board.result, await main.call("board", {})).find(
      (each) => each.id === card.id,
    )?.pulse;
    assert.ok(pulse);
    return pulse.movedAt;
  };
  const before = await movedAt();
  mode = "always-torn";
  const second = await start("unconfirmed");
  assert.deepEqual(await second.exited, [127, null]);
  assert.equal(existsSync(second.marker), false);
  assert.equal(seen.filter(({ job }) => job === second.job).length, 3);
  const result = await worker.waitForEntry(
    (entry) => entry.kind === "job-result" && entry.fields["job"] === second.job,
    "the wrapper's no-start result",
  );
  assert.equal(result.fields["exitCode"], 127);
  assert.equal(result.fields["commandNotStarted"], true);
  assert.equal(result.fields["startupFenced"], undefined);
  assert.match(result.body, /did not confirm wrapper registration/);
  assert.equal(await movedAt(), before);

  const ageLosses = (minutes: number): void => {
    const db = new DatabaseSync(cardd.db, { timeout: 5000 });
    try {
      db.prepare("UPDATE jobs SET updated_at = ? WHERE state = 'lost' AND id IN (?, ?)").run(
        Date.now() - minutes * MINUTE,
        lost,
        control,
      );
    } finally {
      db.close();
    }
  };
  const reminded = (job: number, tier: number) =>
    main.waitForEntry(
      (entry) =>
        entry.card === card.id &&
        entry.fields["condition"] === "job-lost-open" &&
        Number(entry.fields["tier"]) >= tier &&
        entry.body.includes(`job ${String(job)} (`),
      `job ${String(job)} to receive reminder tier ${String(tier)}`,
    );
  ageLosses(1);
  await reminded(lost, 5);

  mode = "retry";
  const third = await start("unconfirmed");
  assert.deepEqual(await third.exited, [0, null]);
  const completed = await worker.waitForEntry(
    (entry) => entry.kind === "job-result" && entry.fields["job"] === third.job,
    "the same-label command that actually ran",
  );
  assert.equal(completed.fields["exitCode"], 0);
  assert.ok(completed.createdAt > before);
  assert.equal(await movedAt(), completed.createdAt);
  ageLosses(2);
  await reminded(control, 10);
  const view = check(CardViewSchema, await main.call("card", { card: card.id }));
  assert.equal(
    view.entries.some(
      (entry) =>
        entry.fields["condition"] === "job-lost-open" &&
        Number(entry.fields["tier"]) >= 10 &&
        entry.body.includes(`job ${String(lost)} (`),
    ),
    false,
  );
});
