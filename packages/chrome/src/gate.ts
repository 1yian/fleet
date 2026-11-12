import Type from "typebox";
import {
  allowedWhileTyped,
  droppedWhileTyped,
  documentPost,
  postKeys,
  readerKeys,
  refusedAlways,
  requestKeys,
  withoutBody,
} from "./rules.ts";
import { parseWire, record, shape, words, type Wire } from "./wire.ts";
import type { Ref, Typing, Verdict } from "./tracking.ts";

export type Decision =
  { readonly send: string } | { readonly answer: string } | { readonly close: string };

type Origin = { readonly target: string } | { readonly parent: string } | { readonly inert: true };

const Attached = Type.Object({
  sessionId: Type.String(),
  targetInfo: Type.Object({ targetId: Type.String(), type: Type.String() }),
});
const Detached = Type.Object({ sessionId: Type.String() });

interface Read {
  readonly method: string;
  readonly ref: Ref;
  readonly epoch: number;
}

const OTHER: Ref = { kind: "other" };
const UNKNOWN: Ref = { kind: "unknown" };

const typedMessage = (method: string): string =>
  `The captain is typing a password in this tab, so ${method} is refused. Wait until the field is empty or the page has moved on, or ask the captain to finish.`;

const unseenMessage = (method: string): string =>
  `The browser guard is not ready for this tab, so ${method} is refused. Try again in a moment.`;

const bodyMessage =
  "The captain typed a password into this request, so its body and its answer are not available to a worker.";

const refusalReply = (wire: Wire, message: string): string =>
  JSON.stringify({
    id: wire.id,
    ...(wire.sessionId === undefined ? {} : { sessionId: wire.sessionId }),
    error: { code: -32000, message },
  });

export class Gate {
  private readonly origins = new Map<string, Origin>();
  private readonly asked = new Map<number, Origin>();
  private readonly reads = new Map<number, Read>();
  private readonly watch: Typing;
  private readonly page: string | undefined;

  constructor(watch: Typing, page: string | undefined) {
    this.watch = watch;
    this.page = page;
  }

  async admit(raw: string): Promise<Decision> {
    const wire = parseWire(raw);
    if (wire?.id === undefined || wire.method === undefined)
      return { close: "a DevTools message must have an id and a method" };
    const ref = await this.refFor(wire.sessionId);
    const verdict = allowedWhileTyped(wire.method, wire.params)
      ? "clear"
      : await this.verdictFor(ref);
    const refusal = this.refusal(wire, wire.method, verdict, ref);
    if (refusal !== undefined) return { answer: refusalReply(wire, refusal) };
    this.remember(wire, wire.id, wire.method);
    if (!allowedWhileTyped(wire.method, wire.params))
      this.reads.set(wire.id, { method: wire.method, ref, epoch: this.watch.epoch(ref) });
    return { send: raw };
  }

  reply(raw: string): string | undefined {
    const wire = parseWire(raw);
    if (wire === undefined) return raw;
    if (wire.id !== undefined) {
      this.answered(wire, wire.id);
      return this.outdated(wire, wire.id) ?? raw;
    }
    if (wire.method === undefined) return raw;
    this.track(wire, wire.method);
    return this.screened(wire, wire.method, raw);
  }

  private refusal(wire: Wire, method: string, verdict: Verdict, ref: Ref): string | undefined {
    if (refusedAlways(method)) return `${method} is not available through the guard.`;
    const held = readerKeys(method, wire.params, wire.sessionId ?? "");
    if (held.some((key) => this.watch.secret(ref, key))) return bodyMessage;
    if (verdict === "clear" || allowedWhileTyped(method, wire.params)) return undefined;
    return verdict === "typed" ? typedMessage(method) : unseenMessage(method);
  }

  private remember(wire: Wire, id: number, method: string): void {
    if (method === "Target.attachToBrowserTarget") this.asked.set(id, { inert: true });
    if (method !== "Target.attachToTarget") return;
    const target = words(record(wire.params), "targetId");
    if (target !== undefined) this.asked.set(id, { target });
  }

  private async refFor(sessionId: string | undefined): Promise<Ref> {
    if (sessionId === undefined)
      return this.page === undefined ? OTHER : this.watch.resolve(this.page);
    const origin = this.origins.get(sessionId);
    if (origin === undefined) return UNKNOWN;
    if ("inert" in origin) return OTHER;
    return "parent" in origin ? this.refFor(origin.parent) : this.watch.resolve(origin.target);
  }

  private refNow(sessionId: string | undefined): Ref {
    if (sessionId === undefined)
      return this.page === undefined ? OTHER : this.watch.peek(this.page);
    const origin = this.origins.get(sessionId);
    if (origin === undefined) return UNKNOWN;
    if ("inert" in origin) return OTHER;
    return "parent" in origin ? this.refNow(origin.parent) : this.watch.peek(origin.target);
  }

  private async verdictFor(ref: Ref): Promise<Verdict> {
    if (ref.kind === "other") return "clear";
    if (ref.kind === "unknown") return this.watch.unplaced();
    return this.watch.settled(ref.id);
  }

  private verdictNow(ref: Ref): Verdict {
    if (ref.kind === "other") return "clear";
    if (ref.kind === "unknown") return this.watch.unplaced();
    return this.watch.verdict(ref.id);
  }

  private outdated(wire: Wire, id: number): string | undefined {
    const read = this.reads.get(id);
    this.reads.delete(id);
    if (read === undefined) return undefined;
    const now = this.verdictNow(read.ref);
    if (this.watch.epoch(read.ref) === read.epoch && now === "clear") return undefined;
    return refusalReply(
      wire,
      now === "unseen" ? unseenMessage(read.method) : typedMessage(read.method),
    );
  }

  private answered(wire: Wire, id: number): void {
    const origin = this.asked.get(id);
    this.asked.delete(id);
    const session = words(record(wire.result), "sessionId");
    if (origin !== undefined && session !== undefined) this.origins.set(session, origin);
  }

  private track(wire: Wire, method: string): void {
    if (method === "Target.detachedFromTarget") {
      const session = shape(Detached, wire.params)?.sessionId;
      if (session !== undefined) this.origins.delete(session);
      return;
    }
    const attached =
      method === "Target.attachedToTarget" ? shape(Attached, wire.params) : undefined;
    if (attached !== undefined) this.origins.set(attached.sessionId, this.originOf(wire, attached));
  }

  private originOf(
    wire: Wire,
    attached: { targetInfo: { targetId: string; type: string } },
  ): Origin {
    const { targetId, type } = attached.targetInfo;
    if (type === "page") return { target: targetId };
    if (type !== "iframe") return { inert: true };
    if (wire.sessionId !== undefined) return { parent: wire.sessionId };
    return { target: this.page ?? targetId };
  }

  private screened(wire: Wire, method: string, raw: string): string | undefined {
    const ref = this.refNow(wire.sessionId);
    const verdict = this.verdictNow(ref);
    if (verdict !== "clear" && droppedWhileTyped(method)) return undefined;
    if (!this.hides(wire, method, ref, verdict)) return raw;
    const params = withoutBody(method, wire.params);
    return params === undefined ? raw : JSON.stringify({ ...wire, params });
  }

  private hides(wire: Wire, method: string, ref: Ref, verdict: Verdict): boolean {
    const session = wire.sessionId ?? "";
    const keys = requestKeys(method, wire.params, session);
    const posts = postKeys(method, wire.params, session);
    const secret = this.watch.armed(ref) || keys.some((key) => this.watch.secret(ref, key));
    this.watch.taint(ref, secret ? [...keys, ...posts] : posts);
    return secret || documentPost(method, wire.params) || verdict !== "clear";
  }
}
