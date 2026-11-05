import type { Shown } from "./browser-poll.ts";

export class Pacer {
  private readonly write: (shown: Shown) => void;
  private inflight = false;
  private waiting: Shown | undefined;

  constructor(write: (shown: Shown) => void) {
    this.write = write;
  }

  send(shown: Shown): void {
    if (this.inflight) {
      this.waiting = shown;
      return;
    }
    this.inflight = true;
    this.write(shown);
  }

  release(): void {
    this.inflight = false;
    const next = this.waiting;
    this.waiting = undefined;
    if (next !== undefined) this.send(next);
  }
}
