import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readBridgeSettings, type BridgeConfig } from "./config.ts";
import { Discord } from "./discord.ts";
import { Inbox } from "./inbox.ts";
import { describeError, fileLog, type Log } from "./log.ts";
import { Outbox } from "./outbox.ts";
import { bridgeState, type BridgeState } from "./state.ts";
import { assistantText } from "./text.ts";
import { transcriber } from "./transcribe.ts";
import { Typing } from "./typing.ts";

const POLL_MS = 2_000;
const DRAIN_MS = 1_000;
const ONLINE = "fleet bridge online.";
const NOT_IN_GUILD =
  "discord bridge: BRIDGE_CHANNEL_ID is not in BRIDGE_GUILD_ID, so the bridge stays off";

function notify(ctx: ExtensionContext, text: string): void {
  if (ctx.hasUI) ctx.ui.notify(text, "info");
  else console.error(text);
}

function attempt(send: () => void): boolean {
  try {
    send();
    return true;
  } catch {
    return false;
  }
}

function injector(pi: ExtensionAPI, ctx: ExtensionContext, log: Log): (text: string) => void {
  return (text) => {
    const queued = (): void => {
      pi.sendUserMessage(text, { deliverAs: "followUp" });
    };
    const now = (): void => {
      pi.sendUserMessage(text);
    };
    if (!attempt(ctx.isIdle() ? now : queued) && !attempt(queued))
      log("the session could not take a message from Discord");
  };
}

async function channelInGuild(config: BridgeConfig, discord: Discord): Promise<boolean> {
  const guild = await discord.channelGuild();
  return guild === undefined || guild === config.guild;
}

async function announce(discord: Discord, state: BridgeState, log: Log): Promise<void> {
  state.botId ??= await discord.me();
  state.cursor ??= await discord.newestId();
  if (state.announced) return;
  state.announced = true;
  await discord.say(ONLINE).catch((error: unknown) => {
    log(`the online notice failed: ${describeError(error)}`);
  });
}

function every(ms: number, work: () => Promise<void>): ReturnType<typeof setInterval> {
  const timer = setInterval(() => {
    void work();
  }, ms);
  timer.unref();
  return timer;
}

function run(pi: ExtensionAPI, home: string, ctx: ExtensionContext, config: BridgeConfig): void {
  const directory = join(home, "state", "discord-bridge");
  const log = fileLog(join(directory, "bridge.log"));
  const discord = new Discord(config, log);
  const state = bridgeState();
  const outbox = new Outbox(discord, state, log, home);
  const typing = new Typing(discord);
  const media = {
    discord,
    directory: join(directory, "media"),
    transcribe: transcriber(config.speech, log),
  };
  const inbox = new Inbox(config, discord, state, media, injector(pi, ctx, log), log);
  const timers: ReturnType<typeof setInterval>[] = [];
  let live = config.guild === undefined;
  let stopped = false;

  pi.on("message_end", (event) => {
    const text = assistantText(event.message);
    if (live && text !== "") outbox.enqueue(text);
  });
  pi.on("agent_start", () => {
    if (live) typing.start();
  });
  pi.on("agent_settled", () => {
    typing.stop();
  });
  pi.on("session_shutdown", () => {
    stopped = true;
    typing.stop();
    for (const timer of timers.splice(0)) clearInterval(timer);
  });

  const begin = async (): Promise<void> => {
    if (!live) live = await channelInGuild(config, discord);
    if (!live) {
      if (!stopped) notify(ctx, NOT_IN_GUILD);
      return;
    }
    await announce(discord, state, log);
    if (stopped) return;
    timers.push(
      every(POLL_MS, () => inbox.poll()),
      every(DRAIN_MS, () => outbox.drain()),
    );
  };
  begin().catch((error: unknown) => {
    log(`starting failed: ${describeError(error)}`);
  });
}

export function startDiscordBridge(pi: ExtensionAPI, home: string, ctx: ExtensionContext): void {
  const settings = readBridgeSettings(home);
  if (settings.state === "off") return;
  if (settings.state === "refused") {
    notify(ctx, `discord bridge: ${settings.why}, so the bridge stays off`);
    return;
  }
  run(pi, home, ctx, settings.config);
}
