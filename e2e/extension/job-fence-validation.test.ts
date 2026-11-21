import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { check, HttpCallSchema, OPS, type Card } from "@fleet/protocol";
import { quote } from "@fleet/protocol/route";
import { WebSocket, WebSocketServer } from "ws";
import { begin, newCard, startFleet, type Fleet } from "../support/fleet.ts";
import { Harness, rawText } from "../support/harness.ts";
import { HerdrLab } from "../support/herdr.ts";
import { records } from "../support/json.ts";
import { until } from "../support/live-fleet.ts";

const EXTENSION = fileURLToPath(new URL("../../packages/extension/src/index.ts", import.meta.url));
const OTHER_LAUNCH = "11111111-1111-4111-8111-111111111111";

let fleet: Fleet;
let h: Harness;
let lab: HerdrLab;
let env: Record<string, string>;
let jobDir: string;
let card: Card;
beforeEach(async () => {
  fleet = await startFleet({ CARDD_TIMING_SCALE: "0.04" });
  h = await Harness.start();
  lab = await HerdrLab.start({});
  const created = await lab.run(["workspace", "create", "--no-focus"]);
  const [workspace] = records([created["workspace"]]).map((each) => each["workspace_id"]);
  if (typeof workspace !== "string") throw new Error("the lab returned no workspace");
  card = await newCard(fleet.main, "Users see one scrollbar");
  const token = await begin(fleet.main, card, "run the tests");
  jobDir = join(h.dir, "jobs");
  mkdirSync(jobDir);
  env = {
    FLEET_URL: fleet.cardd.url,
    FLEET_TOKEN: token,
    FLEET_ROLE: "worker",
    HERDR_SESSION: lab.name,
    HERDR_WORKSPACE_ID: workspace,
    TMPDIR: jobDir,
  };
});
afterEach(async (t) => {
  await lab.printIfFailed(t);
  const stopped = await Promise.allSettled([lab.stop(), h.stop(), fleet.cardd.stop()]);
  const failed = stopped.find((result) => result.status === "rejected");
  if (failed !== undefined) throw new Error(`cleanup failed: ${String(failed.reason)}`);
});

async function proxyCardd(onRegistered: (launch: string) => void) {
  const clients = new Set<WebSocket>();
  const proxy = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8").on("data", (chunk: string) => {
      body += chunk;
    });
    req.on("end", () => {
      void (async () => {
        const { op, args } = check(HttpCallSchema, JSON.parse(body));
        const result = await fleet.cardd.post(env["FLEET_TOKEN"] ?? "", op, args);
        res.writeHead(result.status, { "content-type": "application/json" });
        res.end(typeof result.body === "string" ? result.body : JSON.stringify(result.body));
        if (op === "job.register" && result.status === 200)
          onRegistered(check(OPS["job.register"].args, args).launch);
      })().catch((error: unknown) => res.destroy(error instanceof Error ? error : undefined));
    });
  });
  const sockets = new WebSocketServer({ server: proxy });
  sockets.on("connection", (client) => {
    const upstream = new WebSocket(fleet.cardd.url);
    clients.add(client);
    client.pause();
    upstream.on("open", () => client.resume());
    client.on("message", (raw) => {
      if (upstream.readyState === WebSocket.OPEN) upstream.send(rawText(raw));
    });
    upstream.on("message", (raw) => {
      if (client.readyState === WebSocket.OPEN) client.send(rawText(raw));
    });
    upstream.on("error", () => client.terminate());
    upstream.on("close", () => client.terminate());
    client.on("error", () => upstream.terminate());
    client.on("close", () => upstream.terminate());
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const address = proxy.address();
  assert.ok(address && typeof address !== "string");
  env["FLEET_URL"] = `ws://127.0.0.1:${String(address.port)}/session`;
  return {
    stop: (): void => {
      for (const client of clients) client.terminate();
      sockets.close();
      proxy.closeAllConnections();
      proxy.close();
    },
    pushFence: (id: number, extra: Record<string, unknown>): void => {
      const message = JSON.stringify({
        t: "entry",
        entry: {
          id,
          card: card.id,
          author: "job:1",
          kind: "job-result",
          body: "could not start: injected fence",
          fields: { job: 1, label: "gate", exitCode: 127, startupFenced: true, ...extra },
          createdAt: Date.now(),
        },
        name: "users-see-one-scrollbar",
        mode: "followUp",
      });
      for (const client of clients) if (client.readyState === WebSocket.OPEN) client.send(message);
    },
  };
}

test("only a startup fence naming the pending launch closes a live job tab", async (t) => {
  const registered = Promise.withResolvers<string>();
  const proxy = await proxyCardd((launch) => registered.resolve(launch));
  t.after(() => proxy.stop());
  const bin = join(jobDir, "bin");
  mkdirSync(bin);
  const closes = join(jobDir, "tab-closes");
  const herdr = execFileSync("sh", ["-c", "command -v herdr"], { encoding: "utf8" }).trim();
  writeFileSync(
    join(bin, "herdr"),
    `#!/bin/sh
if [ "$1 $2" = 'tab close' ]; then
  echo "$3" >> ${quote(closes)}
fi
exec ${quote(herdr)} "$@"
`,
    { mode: 0o755 },
  );
  env["PATH"] = `${bin}:${process.env["PATH"] ?? ""}`;
  h.onModel(() => ({ tool: "run_long", args: { label: "gate", command: "sleep 120" } }));
  h.onModel(() => ({ text: "waiting for the gate" }));
  h.startPi("c-1-a1", env, [EXTENSION]);
  const launch = await registered.promise;
  const gateTab = async () => {
    const listed = await lab.run(["tab", "list", "--workspace", env["HERDR_WORKSPACE_ID"] ?? ""]);
    return records(listed["tabs"]).find((tab) => tab["label"] === "job-1-gate");
  };
  const live = await gateTab();
  assert.ok(live);

  proxy.pushFence(1001, {});
  proxy.pushFence(1002, { startupLaunch: OTHER_LAUNCH });
  proxy.pushFence(1003, { startupLaunch: 7 });
  proxy.pushFence(1004, { startupLaunch: "not-a-launch" });
  await h.waitForNth((event) => event["type"] === "fleet_delivered", 4, "the invalid fences");
  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.equal(existsSync(closes), false);
  assert.equal((await gateTab())?.["tab_id"], live["tab_id"]);

  proxy.pushFence(1005, { startupLaunch: launch });
  await until(
    () => (existsSync(closes) ? readFileSync(closes, "utf8").trim() : undefined),
    "the matching fence to close the tab",
  );
  assert.equal(readFileSync(closes, "utf8").trim(), live["tab_id"]);
  await until(async () => ((await gateTab()) === undefined ? true : undefined), "the tab to close");
});
