import type { Shown } from "./browser-poll.ts";

export class Pacer {
  private static issued = 0;
  private readonly write: (shown: Shown, seq: number) => void;
  private inflight: number | undefined;
  private waiting: Shown | undefined;

  constructor(write: (shown: Shown, seq: number) => void) {
    this.write = write;
  }

  send(shown: Shown): void {
    if (this.inflight !== undefined) {
      this.waiting = shown;
      return;
    }
    Pacer.issued += 1;
    this.inflight = Pacer.issued;
    this.write(shown, this.inflight);
  }

  release(seq: number): void {
    if (seq !== this.inflight) return;
    this.inflight = undefined;
    const next = this.waiting;
    this.waiting = undefined;
    if (next !== undefined) this.send(next);
  }
}
