import type { BridgeConfig } from "./config.ts";
import type { Discord } from "./discord.ts";
import type { Health } from "./health.ts";
import { parseMessage, render, type Inbound, type Media } from "./inbound.ts";
import { describeError, type Log } from "./log.ts";
import type { BridgeState } from "./state.ts";

function byId(left: Inbound, right: Inbound): number {
  const a = BigInt(left.id);
  const b = BigInt(right.id);
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

export class Inbox {
  private readonly allowed: ReadonlySet<string>;
  private readonly discord: Discord;
  private readonly state: BridgeState;
  private readonly media: Media;
  private readonly inject: (text: string) => void;
  private readonly log: Log;
  private readonly health: Health;
  private polling = false;

  constructor(
    config: BridgeConfig,
    discord: Discord,
    state: BridgeState,
    media: Media,
    inject: (text: string) => void,
    log: Log,
    health: Health,
  ) {
    this.allowed = config.allowed;
    this.discord = discord;
    this.state = state;
    this.media = media;
    this.inject = inject;
    this.log = log;
    this.health = health;
  }

  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      await this.fetchNew();
      this.health.succeeded("poll");
    } catch (error) {
      this.health.failed("poll");
      this.log(`reading messages failed: ${describeError(error)}`);
    } finally {
      this.polling = false;
    }
  }

  private async fetchNew(): Promise<void> {
    if (this.state.cursor === undefined) {
      this.state.cursor = await this.discord.newestId();
      if (this.state.cursor === undefined) throw new Error("the newest message could not be read");
      return;
    }
    const page = await this.discord.messagesAfter(this.state.cursor);
    if (page === undefined) throw new Error("the new messages could not be read");
    const messages = page
      .map(parseMessage)
      .filter((message) => message !== undefined)
      .sort(byId);
    for (const message of messages) {
      this.state.cursor = message.id;
      await this.accept(message);
    }
  }

  private async accept(message: Inbound): Promise<void> {
    const { author } = message;
    if (author === undefined || author === this.state.botId || !this.allowed.has(author)) return;
    const text = await render(message, this.media);
    if (text !== "") this.inject(text);
  }
}
