import type { Discord } from "./discord.ts";

const REFRESH_MS = 8_000;

export class Typing {
  private readonly discord: Discord;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(discord: Discord) {
    this.discord = discord;
  }

  start(): void {
    if (this.timer !== undefined) return;
    void this.discord.typing();
    this.timer = setInterval(() => {
      void this.discord.typing();
    }, REFRESH_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer === undefined) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }
}
