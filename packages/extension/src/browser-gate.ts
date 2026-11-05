export interface Frame {
  readonly data: string;
  readonly width: number;
  readonly height: number;
}

interface Hidden {
  readonly hidden: string;
}

export type Shown = Frame | Hidden;

export interface Clearance {
  readonly clear: boolean;
  readonly note: string | null;
}

const UNCHECKED = "the viewer could not check this page for a stored credential";

export class Gate {
  private pending: Frame | undefined;
  private busy = false;
  private readonly ask: () => Promise<Clearance>;
  private readonly show: (shown: Shown) => void;

  constructor(ask: () => Promise<Clearance>, show: (shown: Shown) => void) {
    this.ask = ask;
    this.show = show;
  }

  offer(frame: Frame): void {
    this.pending = frame;
    if (!this.busy) this.drain().catch(() => undefined);
  }

  private async drain(): Promise<void> {
    this.busy = true;
    try {
      for (let frame = this.pending; frame !== undefined; frame = this.pending) {
        this.pending = undefined;
        const answer = await this.ask().catch(() => ({ clear: false, note: null }));
        this.show(answer.clear ? frame : { hidden: answer.note ?? UNCHECKED });
      }
    } finally {
      this.busy = false;
    }
  }
}
