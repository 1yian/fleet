import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { CardViewSchema, check, HttpCallSchema, HttpOutcomeSchema, OPS } from "@fleet/protocol";
import { quote } from "@fleet/protocol/route";
import { begin, newCard, startFleet } from "../support/fleet.ts";
import { spawnGuarded } from "../support/guarded.ts";
import { HerdrLab } from "../support/herdr.ts";
import { until } from "../support/live-fleet.ts";
import { tempDir } from "../support/run-root.ts";

const WRAPPER = fileURLToPath(new URL("../../packages/extension/src/job.ts", import.meta.url));

test("a prepared wrapper does not run Bash until a complete registration receipt arrives", async (t) => {
  const { main, cardd } = await startFleet();
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
    proxy.closeAllConnections();
    proxy.close();
  });
  const address = proxy.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${String(address.port)}/call`;

  const start = async (label: string) => {
    const launch = randomUUID();
    const marker = join(dir, label);
    const command = `touch ${quote(marker)}; echo ${label}`;
    const response = await cardd.post(token, "job.prepare", { label, command, launch });
    const outcome = check(HttpOutcomeSchema, response.body);
    assert.ok(outcome.ok);
    const { job, heartbeatMs } = check(OPS["job.prepare"].result, outcome.value);
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
  permit.resolve();
  assert.deepEqual(await first.exited, [0, null]);
  assert.equal(existsSync(first.marker), true);

  mode = "always-torn";
  const second = await start("unconfirmed");
  assert.deepEqual(await second.exited, [127, null]);
  assert.equal(existsSync(second.marker), false);
  assert.equal(seen.filter(({ job }) => job === second.job).length, 3);
  const view = check(CardViewSchema, await main.call("card", { card: card.id }));
  const result = view.entries.find((entry) => entry.fields["job"] === second.job);
  assert.equal(result?.fields["exitCode"], 127);
  assert.match(result?.body ?? "", /did not confirm wrapper registration/);
});
