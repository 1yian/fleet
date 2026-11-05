import type { Shown } from "./browser-poll.ts";

const ACK_WAIT_MS = 3_000;

export class Pacer {
  private readonly write: (shown: Shown) => void;
  private inflight = false;
  private waiting: Shown | undefined;
  private timer: NodeJS.Timeout | undefined;

  constructor(write: (shown: Shown) => void) {
    this.write = write;
  }

  send(shown: Shown): void {
    if (this.inflight) {
      this.waiting = shown;
      return;
    }
    this.inflight = true;
    this.timer = setTimeout(() => {
      this.release();
    }, ACK_WAIT_MS);
    this.write(shown);
  }

  release(): void {
    clearTimeout(this.timer);
    this.inflight = false;
    const next = this.waiting;
    this.waiting = undefined;
    if (next !== undefined) this.send(next);
  }

  stop(): void {
    clearTimeout(this.timer);
    this.waiting = undefined;
  }
}
