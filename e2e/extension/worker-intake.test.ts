import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { parseServerMessage, type Card } from "@fleet/protocol";
import { begin, newCard, startFleet, type Fleet } from "../support/fleet.ts";
import { gate, Harness, type Turn } from "../support/harness.ts";
import { HerdrLab } from "../support/herdr.ts";
import { records } from "../support/json.ts";

const EXTENSION = fileURLToPath(new URL("../../packages/extension/src/index.ts", import.meta.url));
const RESULT = "[fleet] c-1 users-see-one-scrollbar job 1 (tests) exited 0: green";
const AGAIN = `${RESULT} (sent again: the turn that got it ended before it was taken in)`;
const ROUTING =
  "pi-tiers: no usable model for tier 'default' (anthropic/claude-opus-5-5 on anthropic: cooling, openai/gpt-5 on openai: cooling)";

let fleet: Fleet;
let h: Harness;
let lab: HerdrLab;
let env: Record<string, string>;
let card: Card;
beforeEach(async () => {
  fleet = await startFleet({ CARDD_TIMING_SCALE: "0.02" });
  h = await Harness.start();
  lab = await HerdrLab.start({});
  const created = await lab.run(["workspace", "create", "--no-focus"]);
  const [workspace] = records([created["workspace"]]).map((each) => each["workspace_id"]);
  if (typeof workspace !== "string") throw new Error("the lab returned no workspace");
  card = await newCard(fleet.main, "Users see one scrollbar");
  const token = await begin(fleet.main, card, "run the tests");
  const jobDir = join(h.dir, "jobs");
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

const lastUser = (turns: Turn[]): string | undefined =>
  turns.findLast((turn) => turn.role === "user")?.text;

test("a job result whose turn the provider fails is not lost: its mate hears one incident, and the result is sent again once the worker recovers", async () => {
  h.onModel(() => ({ tool: "run_long", args: { label: "tests", command: "echo green" } }));
  h.onModel(() => ({ text: "waiting for the tests" }));
  h.onModel(() => ({ fail: ROUTING }));
  h.onModel(() => ({ tool: "report", args: { status: "note", text: "alive" } }));
  h.onModel(() => ({ text: "recovered" }));
  h.onModel(() => ({ text: "took the job result" }));
  h.startPi("c-1-a1", env, [EXTENSION]);

  assert.equal(lastUser(await h.waitForCall(2)), RESULT);
  const heard = await fleet.main.waitForEntry(
    (entry) => entry.fields["condition"] === "runtime-failure",
    "the mate to hear why the worker could not take the job result",
  );
  assert.match(
    heard.body,
    new RegExp(
      `its model turn failed: ${ROUTING.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\. Classified router-cooldown\\.`,
    ),
  );
  const due = await fleet.main.waitForEntry(
    (entry) => entry.body.includes("is eligible for recovery now"),
    "the one wake at the eligible time",
  );
  const [, incident, generation] =
    /Incident (\d+), process generation (\d+)/.exec(heard.body) ?? [];
  await fleet.main.call("card.restart", {
    card: heard.card,
    incident: Number(incident),
    generation: Number(generation),
    mode: "retry",
    key: "mate-retry",
  });
  await fleet.main.waitForEntry(
    (entry) => entry.body.includes("recovered (retry)"),
    "verification",
  );

  assert.equal(lastUser(await h.waitForCall(5)), AGAIN);
  assert.ok(due.id > heard.id);
  const entries = fleet.main.entries.map((push) => push.entry);
  assert.equal(entries.filter((entry) => entry.fields["condition"] === "missed").length, 0);
  assert.equal(
    h.calls
      .slice(0, 5)
      .flat()
      .filter((turn) => turn.text.startsWith("[fleet] Your run is ending")).length,
    0,
  );
});

test("a worker that reads its assignment and then stays in one long run is not flagged as having missed it", async () => {
  h.onModel(() => ({ tool: "report", args: { status: "note", text: "on it" } }));
  h.onModel(async () => {
    await new Promise((resolve) => setTimeout(resolve, 12_000));
    return { text: "the long run is done" };
  });
  h.startPi("c-1-a1", env, [EXTENSION]);

  await h.waitForCall(2, "default", 30_000);
  const entries = fleet.main.entries.map((push) => push.entry);
  assert.equal(entries.filter((entry) => entry.fields["condition"] === "missed").length, 0);
  assert.equal(
    h.calls.flat().filter((turn) => turn.text.includes("sent again: the turn that got it ended"))
      .length,
    0,
  );
});

test("a job result that arrives while the worker is in one long run is not sent again or flagged as missed, and is taken in when the run ends", async () => {
  h.onModel(() => ({ tool: "run_long", args: { label: "tests", command: "echo green" } }));
  h.onModel(async () => {
    await new Promise((resolve) => setTimeout(resolve, 12_000));
    return { text: "the long run is over" };
  });
  h.onModel(() => ({ text: "took the job result" }));
  h.startPi("c-1-a1", env, [EXTENSION]);

  assert.equal(lastUser(await h.waitForCall(2, "default", 30_000)), RESULT);
  const entries = fleet.main.entries.map((push) => push.entry);
  assert.equal(entries.filter((entry) => entry.fields["condition"] === "missed").length, 0);
  assert.equal(
    h.calls.flat().filter((turn) => turn.text.includes("sent again: the turn that got it ended"))
      .length,
    0,
  );
});

test("a comment that arrives after the worker's connection dropped and came back during one long run is not sent again or flagged as missed", async () => {
  h.onModel(() => ({ tool: "report", args: { status: "note", text: "on it" } }));
  h.onModel(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10_000));
    return { text: "the long run is over" };
  });
  h.onModel(() => ({ text: "took the comment" }));
  h.startPi("c-1-a1", env, [EXTENSION]);

  await h.waitForCall(1, "default", 30_000);
  await fleet.cardd.restart();
  const main = await fleet.cardd.connect(fleet.mainToken);
  await h.waitForNth((e) => e["type"] === "fleet_connected", 2, "the worker to reconnect");
  await main.call("comment", { card: card.id, text: "a follow-up", now: false });
  await h.waitForCall(2, "default", 60_000);

  const entries = main.entries.map((push) => push.entry);
  assert.equal(entries.filter((entry) => entry.fields["condition"] === "missed").length, 0);
  assert.equal(
    h.calls.flat().filter((turn) => turn.text.includes("sent again: the turn that got it ended"))
      .length,
    0,
  );
});

interface Proxy {
  readonly url: string;
  readonly dropped: () => number;
  readonly held: () => boolean;
  readonly reconnect: () => void;
  readonly release: () => void;
  readonly close: () => Promise<void>;
}

async function proxyTo(upstream: string): Promise<Proxy> {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  let holding = false;
  let dropping = false;
  let welcomeHeld = false;
  let dropped = 0;
  const heldFrames: { client: WebSocket; text: string }[] = [];
  server.on("connection", (client) => {
    const up = new WebSocket(upstream);
    const early: string[] = [];
    client.on("message", (data) => {
      const text = Buffer.isBuffer(data) ? data.toString("utf8") : "";
      if (up.readyState === WebSocket.OPEN) up.send(text);
      else early.push(text);
    });
    up.on("open", () => {
      for (const text of early) up.send(text);
    });
    up.on("message", (data) => {
      const text = Buffer.isBuffer(data) ? data.toString("utf8") : "";
      const kind = parseServerMessage(text).t;
      if (dropping && kind === "entry") {
        dropped += 1;
        return;
      }
      if (holding) {
        if (kind === "welcome") welcomeHeld = true;
        heldFrames.push({ client, text });
        return;
      }
      client.send(text);
    });
    client.on("close", () => {
      up.close();
    });
    up.on("close", () => {
      client.close();
    });
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    url: `ws://127.0.0.1:${String(port)}`,
    dropped: () => dropped,
    held: () => welcomeHeld,
    reconnect: () => {
      holding = true;
      dropping = true;
      for (const client of server.clients) client.terminate();
    },
    release: () => {
      holding = false;
      for (const { client, text } of heldFrames.splice(0)) client.send(text);
    },
    close: async () => {
      for (const client of server.clients) client.terminate();
      await new Promise((resolve) => {
        server.close(resolve);
      });
    },
  };
}

test("a run that ends between a running hello and its welcome leaves the worker idle, so a comment it never took in is sent again and flagged as missed", async () => {
  const proxy = await proxyTo(fleet.cardd.url);
  const held = gate();
  h.onModel(async () => {
    await held.wait;
    return { text: "the long run is over" };
  });
  try {
    const pi = h.startPi("c-1-a1", { ...env, FLEET_URL: proxy.url }, [EXTENSION]);
    await h.waitForCall(0, "default", 30_000);
    await h.waitFor((e) => e["type"] === "fleet_connected", "the worker to connect");

    proxy.reconnect();
    const deadline = Date.now() + 20_000;
    while (!proxy.held()) {
      if (Date.now() > deadline) throw new Error("the reconnect never reached its welcome");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await fleet.main.call("comment", { card: card.id, text: "a follow-up", now: false });
    while (proxy.dropped() < 1) {
      if (Date.now() > deadline) throw new Error("the comment never reached the worker's session");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    pi.abort();
    await h.waitFor((e) => e["type"] === "settled", "the aborted run to settle");
    proxy.release();

    const missedBy = Date.now() + 40_000;
    while (!fleet.main.entries.some(({ entry }) => entry.fields["condition"] === "missed")) {
      if (Date.now() > missedBy) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const missed = fleet.main.entries.find(({ entry }) => entry.fields["condition"] === "missed");
    assert.match(missed?.entry.body ?? "no missed finding", /did not take in this comment/);
    assert.ok(proxy.dropped() >= 4);
  } finally {
    held.open();
    await proxy.close();
  }
});

test("a comment sent while the worker is mid-turn reaches it before its next model call", async () => {
  h.onModel(async () => {
    await fleet.main.call("comment", { card: card.id, text: "scope change: skip the tests" });
    return { tool: "report", args: { status: "note", text: "running the tests" } };
  });
  h.onModel(() => ({ text: "changed course" }));
  h.startPi("c-1-a1", env, [EXTENSION]);

  const second = await h.waitForCall(1, "default", 30_000);
  assert.ok(
    second.some(
      (turn) => turn.role === "user" && turn.text.includes("scope change: skip the tests"),
    ),
    "the model call after the tool result lacks the comment",
  );
});
