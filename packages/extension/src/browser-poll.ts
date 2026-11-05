import type { Frame } from "./browser-screen.ts";

interface Hidden {
  readonly hidden: string;
}

export type Shown = Frame | Hidden;

export interface Pulled {
  readonly image: { readonly mimeType: string; readonly data: string } | null;
  readonly note: string | null;
}

interface Size {
  readonly width: number;
  readonly height: number;
}

interface Pulling {
  readonly listeners: Set<(shown: Shown) => void>;
}

const FLOOR_MS = 150;
const UNAVAILABLE = "the viewer could not get a picture of this page";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function onChange(send: (shown: Shown) => void): (shown: Shown) => void {
  let last: string | undefined;
  return (shown) => {
    if ("hidden" in shown) {
      last = undefined;
      send(shown);
      return;
    }
    const key = `${String(shown.width)}x${String(shown.height)}:${shown.data}`;
    if (key === last) return;
    last = key;
    send(shown);
  };
}

export class Poll {
  private readonly pulling = new Map<string, Pulling>();
  private readonly pull: (target: string) => Promise<Pulled>;
  private readonly measure: (target: string) => Promise<Size>;

  constructor(
    pull: (target: string) => Promise<Pulled>,
    measure: (target: string) => Promise<Size>,
  ) {
    this.pull = pull;
    this.measure = measure;
  }

  watch(target: string, send: (shown: Shown) => void): () => void {
    const listener = onChange(send);
    let pulling = this.pulling.get(target);
    if (pulling === undefined) {
      const fresh: Pulling = { listeners: new Set() };
      pulling = fresh;
      this.pulling.set(target, fresh);
      fresh.listeners.add(listener);
      this.run(target, fresh).catch(() => undefined);
    } else pulling.listeners.add(listener);
    const held = pulling;
    return () => {
      held.listeners.delete(listener);
    };
  }

  private async run(target: string, pulling: Pulling): Promise<void> {
    try {
      while (pulling.listeners.size > 0) {
        const began = Date.now();
        const shown = await this.shown(target);
        for (const listener of pulling.listeners) listener(shown);
        await sleep(Math.max(0, FLOOR_MS - (Date.now() - began)));
      }
    } finally {
      if (this.pulling.get(target) === pulling) this.pulling.delete(target);
    }
  }

  private async shown(target: string): Promise<Shown> {
    try {
      const { image, note } = await this.pull(target);
      if (image === null) return { hidden: note ?? UNAVAILABLE };
      return { data: image.data, ...(await this.measure(target)) };
    } catch {
      return { hidden: UNAVAILABLE };
    }
  }
}
