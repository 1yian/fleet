import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { Cardd } from "../support/cardd.ts";
import { FakeDiscord } from "../support/fake-discord.ts";
import { Harness, poll, type Pi } from "../support/harness.ts";

const EXTENSION = fileURLToPath(new URL("../../packages/extension/src/index.ts", import.meta.url));
const CAPTAIN = "1300000000000000001";
const NORMAL_CLOSE = 1000;
const ABANDONED_CLOSE = 4000;

const BRIDGE_KEYS = [
  "BRIDGE_BOT_TOKEN",
  "BRIDGE_CHANNEL_ID",
  "BRIDGE_ALLOWED_USER_IDS",
  "BRIDGE_GUILD_ID",
  "BRIDGE_DISCORD_API_URL",
  "BRIDGE_GROQ_API_KEY",
  "BRIDGE_GROQ_MODEL",
  "BRIDGE_GROQ_API_URL",
];

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

const bridge = (more: Record<string, string> = {}): Record<string, string> => ({
  ...Object.fromEntries(BRIDGE_KEYS.map((key) => [key, ""])),
  BRIDGE_BOT_TOKEN: discord.token,
  BRIDGE_CHANNEL_ID: discord.channel,
  BRIDGE_ALLOWED_USER_IDS: CAPTAIN,
  BRIDGE_DISCORD_API_URL: discord.apiUrl,
  ...more,
});

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

  await pi.end("SIGTERM");
  await discord.waitForBotStatus("offline", "the bot to show offline");
  assert.deepEqual(closeCodes(), [NORMAL_CLOSE]);
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

test("after the gateway drops the connection the bot identifies as online again", async () => {
  startMain(bridge());
  await waitForConnections(1);

  discord.dropGateways();
  await waitForConnections(2);

  assert.equal(discord.gateways[1]?.status, "online");
  assert.equal(discord.liveGateways, 1);
  assert.equal(discord.botStatus, "online");
});

test("a gateway that stops answering heartbeats is replaced by a fresh connection", async () => {
  startMain(bridge());
  await waitForConnections(1);

  discord.muteGateways();
  await waitForConnections(2);

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
