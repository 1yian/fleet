import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { join } from "node:path";
import { bridgeSettings, EXTENSION } from "../support/bridge-env.ts";
import { askBridge, isStamp, stampAt, waitForStatus } from "../support/bridge-status.ts";
import { Cardd } from "../support/cardd.ts";
import { FakeDiscord } from "../support/fake-discord.ts";
import { Harness, poll, type Pi } from "../support/harness.ts";

const NORMAL_CLOSE = 1000;
const ABANDONED_CLOSE = 4000;

let cardd: Cardd;
let mainToken: string;
let h: Harness;
let discord: FakeDiscord;
beforeEach(async () => {
  cardd = await Cardd.start();
  mainToken = cardd.addLane("main");
  h = await Harness.start();
  discord = await FakeDiscord.start();
});
afterEach(async () => {
  await h.stop();
  await discord.stop();
  await cardd.stop();
});

const home = (): string => join(h.dir, "work");

const bridge = (more: Record<string, string> = {}): Record<string, string> =>
  bridgeSettings(discord, more);

const startMain = (settings: Record<string, string>): Pi =>
  h.startPi(
    "main",
    {
      FLEET_URL: cardd.url,
      FLEET_TOKEN: mainToken,
      FLEET_ROLE: "mate",
      FLEET_LANE: "main",
      ...settings,
    },
    [EXTENSION],
  );

const isReload = (event: Record<string, unknown>): boolean =>
  event["type"] === "session" && event["reason"] === "reload";

const isDiscordNotice = (request: Record<string, unknown>): boolean =>
  request["method"] === "notify" && String(request["message"]).includes("discord bridge");

const closeCodes = (): (number | undefined)[] =>
  discord.gateways.map((session) => session.closeCode);

async function askOnce(pi: Pi): Promise<void> {
  h.onModel(() => ({ text: "Noted." }));
  pi.prompt("Anything new?");
  await h.waitForCall(0);
}

async function waitForConnections(count: number): Promise<void> {
  await poll(
    () =>
      discord.gateways.length === count && discord.gateways.at(-1)?.identified === true
        ? true
        : undefined,
    `connection ${String(count)} to identify`,
  );
}

test("the bot shows online while main runs the bridge and offline as soon as main stops", async () => {
  const pi = startMain(bridge());
  await discord.waitForBotStatus("online", "the bot to show online");
  assert.equal(discord.gateways.length, 1);
  assert.equal(discord.gateways[0]?.status, "online");
  const read = await waitForStatus(home(), "a heartbeat acknowledgement", (status) =>
    isStamp(status("presence.ackAt")),
  );
  assert.equal(read("presence.connected"), true);
  assert.ok(isStamp(read("presence.readyAt")));
  assert.equal(read("presence.lostAt"), "never");
  assert.match(await askBridge(pi), /presence .*: ok\n {2}connected: yes\n {2}last READY: \S+/);

  await pi.end("SIGTERM");
  await discord.waitForBotStatus("offline", "the bot to show offline");
  assert.deepEqual(closeCodes(), [NORMAL_CLOSE]);
  const stopped = await waitForStatus(
    home(),
    "the stopped status",
    (status) => status("state") === "stopped",
  );
  assert.equal(stopped("presence.connected"), false);
});

test("a reload hands the bot to one new connection, however often main reloads", async () => {
  const pi = startMain(bridge());
  await waitForConnections(1);

  for (const reloads of [1, 2]) {
    pi.prompt("/probe-reload");
    await h.waitForNth(isReload, reloads, `reload ${String(reloads)}`);
    await waitForConnections(reloads + 1);
  }
  await askOnce(pi);

  assert.equal(discord.gateways.length, 3, "a reload opened a second connection");
  assert.equal(discord.liveGateways, 1, "an old connection stayed alive across a reload");
  assert.deepEqual(closeCodes(), [NORMAL_CLOSE, NORMAL_CLOSE, undefined]);
  assert.equal(discord.botStatus, "online");
});

async function assertRejoined(pi: Pi): Promise<void> {
  const read = await waitForStatus(
    home(),
    "presence to report the loss and the new READY",
    (status) =>
      isStamp(status("presence.lostAt")) &&
      status("presence.connected") === true &&
      stampAt(status("presence.readyAt")) >= stampAt(status("presence.lostAt")),
  );
  assert.equal(read("state"), "running");
  assert.match(await askBridge(pi), /presence .*: (ok|UNKNOWN, no heartbeat acknowledged yet)\n/);
}

test("after the gateway drops the connection the bot identifies as online again", async () => {
  const pi = startMain(bridge());
  await waitForConnections(1);

  discord.dropGateways();
  await waitForConnections(2);
  await assertRejoined(pi);

  assert.equal(discord.gateways[1]?.status, "online");
  assert.equal(discord.liveGateways, 1);
  assert.equal(discord.botStatus, "online");
});

test("a gateway that stops answering heartbeats is replaced by a fresh connection", async () => {
  const pi = startMain(bridge());
  await waitForConnections(1);

  discord.muteGateways();
  await waitForConnections(2);
  await assertRejoined(pi);

  assert.equal(discord.gateways[0]?.closeCode, ABANDONED_CLOSE);
  assert.equal(discord.gateways[1]?.status, "online");
  assert.equal(discord.liveGateways, 1);
  assert.equal(discord.botStatus, "online");
});

test("a bridge that stays off never shows the bot online", async () => {
  const pi = startMain(bridge({ BRIDGE_GUILD_ID: "1400000000000000001" }));
  await pi.waitForUi(isDiscordNotice, "the bridge notice");
  await askOnce(pi);

  assert.deepEqual(discord.gateways, []);
  assert.equal(discord.botStatus, "offline");
});
