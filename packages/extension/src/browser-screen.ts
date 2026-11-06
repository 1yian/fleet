import { parseCdp, readSelection, type Cdp } from "@fleet/protocol";
import type { Dial } from "@fleet/protocol/tunnel";
import { inputCalls, type ViewerInput } from "./browser-input.ts";
import Type from "typebox";

export interface Frame {
  readonly data: string;
  readonly width: number;
  readonly height: number;
}

const AttachedSchema = Type.Object({ sessionId: Type.String() });
const FrameEventSchema = Type.Object({
  data: Type.String(),
  sessionId: Type.Integer(),
  metadata: Type.Object({ deviceWidth: Type.Number(), deviceHeight: Type.Number() }),
});
const ShotSchema = Type.Object({ data: Type.String() });
const SizeSchema = Type.Object({
  result: Type.Object({ value: Type.Object({ w: Type.Number(), h: Type.Number() }) }),
});

interface Viewing {
  readonly session: string;
  readonly listeners: Set<(frame: Frame) => void>;
  readonly lost: Set<() => void>;
  last: Frame | undefined;
}

export class Screen {
  private link: Promise<Cdp> | undefined;
  private readonly sessions = new Map<string, Promise<string>>();
  private readonly viewing = new Map<string, Viewing>();
  private readonly dial: Dial;

  constructor(dial: Dial) {
    this.dial = dial;
  }

  private connection(): Promise<Cdp> {
    if (this.link === undefined) {
      const link: Promise<Cdp> = this.dial.connect().then((cdp) => {
        cdp.onClose(() => {
          if (this.link === link) this.link = undefined;
          this.sessions.clear();
          const ended = [...this.viewing.values()];
          this.viewing.clear();
          for (const each of ended) for (const lost of each.lost) lost();
        });
        cdp.listen((event) => {
          if (event.method === "Page.screencastFrame")
            this.frame(cdp, event.sessionId, event.params);
        });
        return cdp;
      });
      this.link = link;
      link.catch(() => {
        if (this.link === link) this.link = undefined;
      });
    }
    return this.link;
  }

  private session(cdp: Cdp, target: string): Promise<string> {
    let found = this.sessions.get(target);
    if (found === undefined) {
      found = cdp
        .send("Target.attachToTarget", { targetId: target, flatten: true })
        .then((raw) => parseCdp(AttachedSchema, raw, "an attached tab").sessionId);
      this.sessions.set(target, found);
      found.catch(() => this.sessions.delete(target));
    }
    return found;
  }

  private frame(cdp: Cdp, session: string | undefined, params: unknown): void {
    const event = parseCdp(FrameEventSchema, params, "a screencast frame");
    const owner = [...this.viewing.values()].find((each) => each.session === session);
    if (owner === undefined) return;
    const frame = {
      data: event.data,
      width: event.metadata.deviceWidth,
      height: event.metadata.deviceHeight,
    };
    owner.last = frame;
    for (const listener of owner.listeners) listener(frame);
    cdp
      .send("Page.screencastFrameAck", { sessionId: event.sessionId }, { sessionId: session })
      .catch(() => undefined);
  }

  async watch(
    target: string,
    listener: (frame: Frame) => void,
    lost: () => void,
  ): Promise<() => void> {
    const cdp = await this.connection();
    const session = await this.session(cdp, target);
    let viewing = this.viewing.get(target);
    try {
      viewing ??= await this.begin(cdp, target, session);
      viewing.last ??= await this.still(cdp, session);
    } catch (error) {
      const held = this.viewing.get(target);
      if (held?.session === session && held.listeners.size === 0) this.stop(cdp, target, session);
      throw error;
    }
    viewing.listeners.add(listener);
    viewing.lost.add(lost);
    listener(viewing.last);
    return () => {
      viewing.listeners.delete(listener);
      viewing.lost.delete(lost);
      if (viewing.listeners.size === 0 && this.viewing.get(target) === viewing)
        this.stop(cdp, target, session);
    };
  }

  private async begin(cdp: Cdp, target: string, session: string): Promise<Viewing> {
    const viewing: Viewing = { session, listeners: new Set(), lost: new Set(), last: undefined };
    this.viewing.set(target, viewing);
    await cdp.send("Target.activateTarget", { targetId: target });
    await cdp.send("Page.enable", {}, { sessionId: session });
    await cdp.send(
      "Page.startScreencast",
      { format: "jpeg", quality: 70, maxWidth: 1600, maxHeight: 1200 },
      { sessionId: session },
    );
    return viewing;
  }

  private async measured(cdp: Cdp, session: string): Promise<{ width: number; height: number }> {
    const size = parseCdp(
      SizeSchema,
      await cdp.send(
        "Runtime.evaluate",
        {
          expression: "({ w: innerWidth, h: innerHeight })",
          returnByValue: true,
        },
        { sessionId: session },
      ),
      "the page size",
    );
    return { width: size.result.value.w, height: size.result.value.h };
  }

  async size(target: string): Promise<{ width: number; height: number }> {
    const cdp = await this.connection();
    return this.measured(cdp, await this.session(cdp, target));
  }

  private async still(cdp: Cdp, session: string): Promise<Frame> {
    const shot = parseCdp(
      ShotSchema,
      await cdp.send(
        "Page.captureScreenshot",
        { format: "jpeg", quality: 70 },
        { sessionId: session },
      ),
      "a screenshot",
    );
    return { data: shot.data, ...(await this.measured(cdp, session)) };
  }

  private stop(cdp: Cdp, target: string, session: string): void {
    this.viewing.delete(target);
    cdp.send("Page.stopScreencast", {}, { sessionId: session }).catch(() => undefined);
  }

  async input(event: ViewerInput): Promise<void> {
    const cdp = await this.connection();
    const sessionId = await this.session(cdp, event.target);
    for (const { method, params } of inputCalls(event))
      await cdp.send(method, params, { sessionId });
  }

  async selection(target: string): Promise<string> {
    const cdp = await this.connection();
    return readSelection(cdp, await this.session(cdp, target));
  }

  close(): void {
    this.link?.then(
      (cdp) => {
        cdp.close();
      },
      () => undefined,
    );
    this.dial.close();
  }
}
