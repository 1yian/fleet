import { Cdp, keyPresses, parseCdp } from "@fleet/protocol";
import Type, { type Static } from "typebox";

export const InputSchema = Type.Union([
  Type.Object({
    target: Type.String(),
    kind: Type.Literal("click"),
    x: Type.Number(),
    y: Type.Number(),
  }),
  Type.Object({
    target: Type.String(),
    kind: Type.Literal("scroll"),
    x: Type.Number(),
    y: Type.Number(),
    dy: Type.Number(),
  }),
  Type.Object({ target: Type.String(), kind: Type.Literal("key"), key: Type.String() }),
  Type.Object({ target: Type.String(), kind: Type.Literal("text"), text: Type.String() }),
]);
export type ViewerInput = Static<typeof InputSchema>;

export interface Frame {
  readonly data: string;
  readonly width: number;
  readonly height: number;
}

export interface Live {
  readonly title: string;
  readonly url: string;
}

const AttachedSchema = Type.Object({ sessionId: Type.String() });
const TargetsSchema = Type.Object({
  targetInfos: Type.Array(
    Type.Object({ targetId: Type.String(), title: Type.String(), url: Type.String() }),
  ),
});
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
  private readonly endpoint: () => string | undefined;

  constructor(endpoint: () => string | undefined) {
    this.endpoint = endpoint;
  }

  private connection(): Promise<Cdp> {
    const endpoint = this.endpoint();
    if (endpoint === undefined) return Promise.reject(new Error("no shared browser is configured"));
    if (this.link === undefined) {
      const link: Promise<Cdp> = Cdp.connect(endpoint).then((cdp) => {
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

  async live(): Promise<Map<string, Live>> {
    const cdp = await this.connection();
    const listed = parseCdp(TargetsSchema, await cdp.send("Target.getTargets"), "the target list");
    return new Map(
      listed.targetInfos.map(({ targetId, title, url }) => [targetId, { title, url }]),
    );
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
    if (viewing === undefined) {
      viewing = { session, listeners: new Set(), lost: new Set(), last: undefined };
      this.viewing.set(target, viewing);
      await cdp.send("Target.activateTarget", { targetId: target });
      await cdp.send("Page.enable", {}, { sessionId: session });
      await cdp.send(
        "Page.startScreencast",
        { format: "jpeg", quality: 70, maxWidth: 1600, maxHeight: 1200 },
        { sessionId: session },
      );
    }
    viewing.last ??= await this.still(cdp, session);
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
    return { data: shot.data, width: size.result.value.w, height: size.result.value.h };
  }

  private stop(cdp: Cdp, target: string, session: string): void {
    this.viewing.delete(target);
    cdp.send("Page.stopScreencast", {}, { sessionId: session }).catch(() => undefined);
  }

  async input(event: ViewerInput): Promise<void> {
    const cdp = await this.connection();
    const sessionId = await this.session(cdp, event.target);
    const send = (method: string, params: unknown): Promise<unknown> =>
      cdp.send(method, params, { sessionId });
    if (event.kind === "click") {
      const point = { x: event.x, y: event.y };
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
      const press = { ...point, button: "left", clickCount: 1 };
      await send("Input.dispatchMouseEvent", { type: "mousePressed", ...press });
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", ...press });
    } else if (event.kind === "scroll") {
      await send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: event.x,
        y: event.y,
        deltaX: 0,
        deltaY: event.dy,
      });
    } else if (event.kind === "key") {
      for (const press of keyPresses(event.key)) await send("Input.dispatchKeyEvent", press);
    } else await send("Input.insertText", { text: event.text });
  }

  close(): void {
    this.link?.then(
      (cdp) => {
        cdp.close();
      },
      () => undefined,
    );
  }
}
