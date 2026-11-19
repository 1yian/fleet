import type { Discord } from "./discord.ts";
import { describeError, type Log } from "./log.ts";
import type { BridgeState, Outgoing } from "./state.ts";
import { chunk, extractMedia } from "./text.ts";

function outgoing(text: string): Outgoing {
  const { clean, paths } = extractMedia(text);
  return { parts: chunk(clean), files: paths };
}

export class Outbox {
  private readonly discord: Discord;
  private readonly state: BridgeState;
  private readonly log: Log;

  constructor(discord: Discord, state: BridgeState, log: Log) {
    this.discord = discord;
    this.state = state;
    this.log = log;
  }

  enqueue(text: string): void {
    this.state.queue.push(outgoing(text));
    void this.drain();
  }

  async drain(): Promise<void> {
    if (this.state.draining) return;
    this.state.draining = true;
    try {
      for (let next = this.state.queue[0]; next !== undefined; next = this.state.queue[0]) {
        await this.deliver(next);
        this.state.queue.shift();
      }
    } catch (error) {
      this.log(`posting failed, will retry: ${describeError(error)}`);
    } finally {
      this.state.draining = false;
    }
  }

  private async deliver(item: Outgoing): Promise<void> {
    for (let file = item.files[0]; file !== undefined; file = item.files[0]) {
      const caption = item.parts[0] ?? "";
      const sent = await this.discord.upload(file, caption);
      if (sent && caption !== "") item.parts.shift();
      item.files.shift();
    }
    for (let part = item.parts[0]; part !== undefined; part = item.parts[0]) {
      await this.discord.say(part);
      item.parts.shift();
    }
  }
}
