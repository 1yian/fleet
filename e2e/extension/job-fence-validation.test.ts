import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { afterEach, beforeEach, test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import {
  CardViewSchema,
  check,
  HttpCallSchema,
  parseClientMessage,
  parseServerMessage,
  type Card,
} from "@fleet/protocol";
import { quote } from "@fleet/protocol/route";
import { WebSocket, WebSocketServer } from "ws";
import { begin, newCard, startFleet, type Fleet } from "../support/fleet.ts";
import { Harness, rawText } from "../support/harness.ts";
import { HerdrLab } from "../support/herdr.ts";
import { records } from "../support/json.ts";
import { until } from "../support/live-fleet.ts";
import { DatabaseSync } from "node:sqlite";

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

async function proxyCardd() {
  const clients = new Set<WebSocket>();
  const activities: string[] = [];
  let connections = 0;
  let lists = 0;
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
      })().catch((error: unknown) => res.destroy(error instanceof Error ? error : undefined));
    });
  });
  const sockets = new WebSocketServer({ server: proxy });
  sockets.on("connection", (client) => {
    const upstream = new WebSocket(fleet.cardd.url);
    clients.add(client);
    const listReads = new Set<number>();
    connections += 1;
    client.pause();
    upstream.on("open", () => client.resume());
    client.on("message", (raw) => {
      const text = rawText(raw);
      const message = parseClientMessage(text);
      if (message.t === "activity") activities.push(message.state);
      if (message.t === "call" && message.op === "jobs") listReads.add(message.id);
      if (upstream.readyState === WebSocket.OPEN) upstream.send(text);
    });
    upstream.on("message", (raw) => {
      const text = rawText(raw);
      if (client.readyState === WebSocket.OPEN) client.send(text);
      const message = parseServerMessage(text);
      if (message.t === "result" && listReads.delete(message.id)) lists += 1;
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
    activities,
    connections: (): number => connections,
    lists: (): number => lists,
    stop: (): void => {
      for (const client of clients) client.terminate();
      sockets.close();
      proxy.closeAllConnections();
      proxy.close();
    },
    drop: (): void => {
      for (const client of clients) client.terminate();
    },
    push: (id: number, fields: Record<string, unknown>): void => {
      const message = JSON.stringify({
        t: "entry",
        entry: {
          id,
          card: card.id,
          author: "job:1",
          kind: "job-result",
          body: "could not start: injected fence",
          fields: { label: "gate", exitCode: 127, ...fields },
          createdAt: Date.now(),
        },
        name: "users-see-one-scrollbar",
        mode: "followUp",
      });
      for (const client of clients) if (client.readyState === WebSocket.OPEN) client.send(message);
    },
  };
}

async function holdDispatch(t: TestContext, command: string) {
  const proxy = await proxyCardd();
  t.after(() => proxy.stop());
  const bin = join(jobDir, "bin");
  mkdirSync(bin);
  const closes = join(jobDir, "tab-closes");
  const release = join(jobDir, "release-dispatch");
  const herdr = execFileSync("sh", ["-c", "command -v herdr"], { encoding: "utf8" }).trim();
  writeFileSync(
    join(bin, "herdr"),
    `#!/bin/sh
if [ "$1 $2" = 'tab close' ]; then
  echo "$3" >> ${quote(closes)}
fi
if [ "$1 $2" = 'pane run' ]; then
  exec ${quote(herdr)} pane run "$3" "while [ ! -e ${quote(release)} ]; do sleep 0.05; done; $4"
fi
exec ${quote(herdr)} "$@"
`,
    { mode: 0o755 },
  );
  env["PATH"] = `${bin}:${process.env["PATH"] ?? ""}`;
  h.onModel(() => ({ tool: "run_long", args: { label: "gate", command } }));
  h.onModel(() => ({ text: "waiting for the gate" }));
  h.startPi("c-1-a1", env, [EXTENSION]);
  await until(
    () => (proxy.activities.includes("waiting") ? true : undefined),
    "the worker to publish waiting for the dispatched job",
  );
  const input = readdirSync(jobDir).find((name) => /^fleet-job-1-.+\.json$/.test(name));
  assert.ok(input);
  const launch = /^fleet-job-1-(.+)\.json$/.exec(input)?.[1];
  assert.ok(launch);
  const tabs = async () => {
    const listed = await lab.run(["tab", "list", "--workspace", env["HERDR_WORKSPACE_ID"] ?? ""]);
    return records(listed["tabs"]);
  };
  const gate = (await tabs()).find((tab) => tab["label"] === "job-1-gate");
  assert.ok(gate);
  return {
    proxy,
    closes,
    release,
    input: join(jobDir, input),
    launch,
    tab: String(gate["tab_id"]),
    tabs,
  };
}

const expireJob = (): void => {
  const db = new DatabaseSync(fleet.cardd.db, { timeout: 5000 });
  try {
    db.prepare("UPDATE jobs SET created_at = created_at - 60000 WHERE id = 1").run();
  } finally {
    db.close();
  }
};

const deliveredCount = (): number =>
  h.events.filter((event) => event["type"] === "fleet_delivered").length;

test("incomplete or unbound startup fences leave the wait, wrapper input, and tab alone until cardd's expiry fences the real launch", async (t) => {
  const { proxy, closes, input, launch, tab, tabs } = await holdDispatch(t, "echo gate");
  const other = { startupFenced: true, startupLaunch: OTHER_LAUNCH };
  const variants: Record<string, unknown>[] = [
    { job: 1, startupFenced: true },
    { job: 1, ...other },
    { job: 1, startupFenced: true, startupLaunch: 7 },
    { job: 1, startupFenced: true, startupLaunch: "not-a-launch" },
    { job: 1, startupFenced: "true", startupLaunch: launch },
    { job: 1, startupLaunch: launch },
    { job: 2, startupFenced: true, startupLaunch: launch },
    { job: 1.5, startupFenced: true, startupLaunch: launch },
  ];
  const before = deliveredCount();
  const mark = proxy.activities.length;
  variants.forEach((fields, index) => proxy.push(1001 + index, fields));
  await h.waitForNth(
    (event) => event["type"] === "fleet_delivered",
    before + variants.length,
    "the invalid fences",
  );
  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.equal(existsSync(closes), false);
  assert.ok(existsSync(input));
  assert.ok((await tabs()).some((each) => each["tab_id"] === tab));
  assert.equal(proxy.activities.slice(mark).includes("idle"), false);

  expireJob();
  await until(
    () => (existsSync(closes) ? readFileSync(closes, "utf8").trim() : undefined),
    "cardd's real expiry fence to close the tab",
  );
  assert.equal(readFileSync(closes, "utf8").trim(), tab);
  assert.equal(existsSync(input), false);
  await until(
    async () => ((await tabs()).some((each) => each["tab_id"] === tab) ? undefined : true),
    "the fenced tab to close",
  );
  assert.deepEqual(await jobResults(), [
    [1, 127, "could not start: wrapper did not register before the startup deadline"],
  ]);
});

test("an unbound startup fence cannot end a registered job's wait after a job list released the pending input", async (t) => {
  const done = join(jobDir, "gate-done");
  const { proxy, closes, release, launch } = await holdDispatch(
    t,
    `while [ ! -e ${quote(done)} ]; do sleep 0.05; done; echo gate`,
  );
  writeFileSync(release, "");
  await until(() => (wrapperPid() === null ? undefined : true), "the wrapper to register");
  const lists = proxy.lists();
  proxy.drop();
  await until(
    () => (proxy.lists() > lists ? true : undefined),
    "the reconnect job list to release the pending input",
  );
  const delivered = deliveredCount();
  const mark = proxy.activities.length;
  proxy.push(1001, { job: 1, startupFenced: true, startupLaunch: OTHER_LAUNCH });
  proxy.push(1002, { job: 2, startupFenced: true, startupLaunch: launch });
  await h.waitForNth(
    (event) => event["type"] === "fleet_delivered",
    delivered + 2,
    "the unbound fences",
  );
  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.equal(proxy.activities.slice(mark).includes("idle"), false);
  assert.equal(existsSync(closes), false);

  writeFileSync(done, "");
  await until(
    () => (proxy.activities.slice(mark).includes("idle") ? true : undefined),
    "the real job result to end the wait",
  );
  assert.deepEqual(await jobResults(), [[1, 0, "gate"]]);
});

const jobResults = async () =>
  check(CardViewSchema, await fleet.main.call("card", { card: card.id }))
    .entries.filter((entry) => entry.kind === "job-result")
    .map((entry) => [entry.fields["job"], entry.fields["exitCode"], entry.body]);

const wrapperPid = (): unknown => {
  const db = new DatabaseSync(fleet.cardd.db, { readOnly: true, timeout: 5000 });
  try {
    return db.prepare("SELECT wrapper_pid FROM jobs WHERE id = 1").get()?.["wrapper_pid"] ?? null;
  } finally {
    db.close();
  }
};
