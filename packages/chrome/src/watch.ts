import { setTimeout as sleep } from "node:timers/promises";
import { Cdp, type CdpEvent } from "@fleet/protocol";
import Type from "typebox";
import { Scanner } from "./roots.ts";
import { BINDING, PAGE_SCRIPT, RESCAN } from "./script.ts";
import { Contexts, Targets, type Ref } from "./tracking.ts";
import { record, shape, words } from "./wire.ts";

export type Verdict = "clear" | "typed" | "unseen";

export interface Typing {
  resolve(targetId: string): Promise<Ref>;
  peek(targetId: string): Ref;
  verdict(pageId: string): Verdict;
  settled(pageId: string): Promise<Verdict>;
  unplaced(): Verdict;
  epoch(ref: Ref): number;
}

const TargetInfo = Type.Object({ targetId: Type.String(), type: Type.String() });
const Created = Type.Object({ targetInfo: TargetInfo });
const Destroyed = Type.Object({ targetId: Type.String() });
const Attached = Type.Object({ sessionId: Type.String(), targetInfo: TargetInfo });
const Detached = Type.Object({ sessionId: Type.String() });
const ContextCreated = Type.Object({
  context: Type.Object({
    id: Type.Integer(),
    auxData: Type.Optional(Type.Object({ isDefault: Type.Optional(Type.Boolean()) })),
  }),
});
const ContextDestroyed = Type.Object({ executionContextId: Type.Integer() });
const Lifecycle = Type.Object({ name: Type.String() });
const Bound = Type.Object({
  name: Type.String(),
  payload: Type.String(),
  executionContextId: Type.Integer(),
});

const RETRY_MS = 1000;
const TICK_MS = 2000;
const SETTLE_MS = 3000;
const KNOWN_MS = 500;
const IFRAMES_ONLY = [{ type: "iframe" }, { exclude: true }];
const LOADED = new Set(["DOMContentLoaded", "load"]);

interface Page {
  readonly sessions: Set<string>;
  readonly pending: Set<string>;
}

type Handler = (cdp: Cdp, event: CdpEvent) => void;

export class Watch implements Typing {
  private readonly pages = new Map<string, Page>();
  private readonly owners = new Map<string, string>();
  private readonly epochs = new Map<string, number>();
  private readonly injected = new Set<string>();
  private readonly prepared = new Set<string>();
  private readonly scanner = new Scanner();
  private readonly targets = new Targets();
  private readonly contexts = new Contexts();
  private readonly waiters = new Set<() => void>();
  private readonly endpoint: () => string;
  private readonly handlers = new Map<string, Handler>([
    [
      "Target.targetCreated",
      (cdp, event) => {
        this.onCreated(cdp, event);
      },
    ],
    [
      "Target.targetDestroyed",
      (_cdp, event) => {
        this.onDestroyed(event);
      },
    ],
    [
      "Target.attachedToTarget",
      (cdp, event) => {
        this.onAttached(cdp, event);
      },
    ],
    [
      "Target.detachedFromTarget",
      (_cdp, event) => {
        this.onDetached(event);
      },
    ],
    [
      "Runtime.executionContextCreated",
      (_cdp, event) => {
        this.onContext(event);
      },
    ],
    [
      "Runtime.executionContextDestroyed",
      (_cdp, event) => {
        this.onContextGone(event);
      },
    ],
    [
      "Runtime.executionContextsCleared",
      (_cdp, event) => {
        this.onCleared(event);
      },
    ],
    [
      "Runtime.bindingCalled",
      (cdp, event) => {
        this.onBound(cdp, event);
      },
    ],
    [
      "Page.lifecycleEvent",
      (cdp, event) => {
        this.onLifecycle(cdp, event);
      },
    ],
    [
      "Page.frameNavigated",
      (cdp, event) => {
        this.onNavigated(cdp, event);
      },
    ],
  ]);
  private stopped = false;
  private live = false;
  private clock = 0;
  private lostAt = 0;
  private typedAt = 0;
  private current: Cdp | undefined;

  constructor(endpoint: () => string) {
    this.endpoint = endpoint;
  }

  start(): void {
    void this.run();
  }

  stop(): void {
    this.stopped = true;
    this.current?.close();
  }

  async resolve(targetId: string): Promise<Ref> {
    await this.waitFor(() => this.targets.has(targetId), KNOWN_MS);
    this.targets.unlist(targetId);
    return this.targets.ref(targetId);
  }

  peek(targetId: string): Ref {
    return this.targets.ref(targetId);
  }

  verdict(pageId: string): Verdict {
    const page = this.pages.get(pageId);
    if (page === undefined || page.pending.size > 0) return "unseen";
    return [...page.sessions].some((session) => this.contexts.typed(session)) ? "typed" : "clear";
  }

  async settled(pageId: string): Promise<Verdict> {
    await this.waitFor(() => this.verdict(pageId) !== "unseen", SETTLE_MS);
    return this.verdict(pageId);
  }

  unplaced(): Verdict {
    if (!this.live) return "unseen";
    const verdicts = [...this.pages.keys()].map((id) => this.verdict(id));
    if (verdicts.includes("typed")) return "typed";
    return verdicts.includes("unseen") ? "unseen" : "clear";
  }

  epoch(ref: Ref): number {
    if (ref.kind === "other") return 0;
    const typedAt = ref.kind === "page" ? (this.epochs.get(ref.id) ?? 0) : this.typedAt;
    return Math.max(typedAt, this.lostAt);
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.watchOnce();
      } catch (error) {
        console.error(`guard: waiting for the browser: ${String(error)}`);
      }
      this.reset();
      await sleep(RETRY_MS);
    }
  }

  private async watchOnce(): Promise<void> {
    const cdp = await Cdp.connect(this.endpoint());
    this.current = cdp;
    const closed = new Promise<void>((resolve) => {
      cdp.onClose(resolve);
    });
    cdp.listen((event) => {
      this.handlers.get(event.method)?.(cdp, event);
    });
    await cdp.send("Target.setDiscoverTargets", { discover: true });
    this.live = true;
    this.notify();
    console.error("guard: watching the browser");
    const tick = setInterval(() => {
      this.scanner.retry(cdp);
    }, TICK_MS);
    try {
      await closed;
    } finally {
      clearInterval(tick);
    }
  }

  private reset(): void {
    this.live = false;
    this.lostAt = ++this.clock;
    this.epochs.clear();
    this.injected.clear();
    this.prepared.clear();
    this.scanner.clear();
    this.pages.clear();
    this.owners.clear();
    this.targets.clear();
    this.contexts.clear();
    this.notify();
  }

  private notify(): void {
    for (const waiter of [...this.waiters]) waiter();
  }

  private waitFor(done: () => boolean, ms: number): Promise<boolean> {
    if (done()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const finish = (result: boolean): void => {
        clearTimeout(timer);
        this.waiters.delete(check);
        resolve(result);
      };
      const check = (): void => {
        if (done()) finish(true);
      };
      const timer = setTimeout(() => {
        finish(done());
      }, ms);
      this.waiters.add(check);
    });
  }

  private onCreated(cdp: Cdp, event: CdpEvent): void {
    const info = shape(Created, event.params)?.targetInfo;
    if (info === undefined) return;
    this.targets.add(info.targetId, info.type);
    this.notify();
    if (info.type === "page") void this.attachPage(cdp, info.targetId);
  }

  private onDestroyed(event: CdpEvent): void {
    const id = shape(Destroyed, event.params)?.targetId;
    if (id === undefined) return;
    for (const session of this.pages.get(id)?.sessions ?? []) this.forget(session);
    this.pages.delete(id);
    this.epochs.delete(id);
    this.targets.remove(id);
    this.notify();
  }

  private onAttached(cdp: Cdp, event: CdpEvent): void {
    const attached = shape(Attached, event.params);
    const page = event.sessionId === undefined ? undefined : this.owners.get(event.sessionId);
    if (attached === undefined || page === undefined || attached.targetInfo.type !== "iframe")
      return;
    this.targets.frame(attached.targetInfo.targetId, page);
    this.adopt(page, attached.sessionId);
    this.pages.get(page)?.pending.add(attached.sessionId);
    void this.prepareFrame(cdp, page, attached.sessionId);
  }

  private onDetached(event: CdpEvent): void {
    const session = shape(Detached, event.params)?.sessionId;
    if (session !== undefined) this.forget(session);
    this.notify();
  }

  private onContext(event: CdpEvent): void {
    const context = shape(ContextCreated, event.params)?.context;
    if (context === undefined || event.sessionId === undefined) return;
    this.contexts.created(event.sessionId, context.id, context.auxData?.isDefault === true);
  }

  private onContextGone(event: CdpEvent): void {
    const id = shape(ContextDestroyed, event.params)?.executionContextId;
    if (id === undefined || event.sessionId === undefined) return;
    this.contexts.destroyed(event.sessionId, id);
    this.notify();
  }

  private onCleared(event: CdpEvent): void {
    if (event.sessionId === undefined) return;
    this.contexts.drop(event.sessionId);
    this.notify();
  }

  private onLifecycle(cdp: Cdp, event: CdpEvent): void {
    const name = shape(Lifecycle, event.params)?.name;
    if (name !== undefined && LOADED.has(name) && event.sessionId !== undefined)
      this.rescan(cdp, event.sessionId);
  }

  private onNavigated(cdp: Cdp, event: CdpEvent): void {
    if (event.sessionId === undefined) return;
    this.scanner.navigated(event.sessionId);
    this.rescan(cdp, event.sessionId);
  }

  private rescan(cdp: Cdp, session: string): void {
    if (this.prepared.has(session)) this.scanner.rescan(cdp, session);
  }

  private onBound(cdp: Cdp, event: CdpEvent): void {
    const call = shape(Bound, event.params);
    if (call?.name !== BINDING || event.sessionId === undefined) return;
    if (call.payload === RESCAN) {
      this.rescan(cdp, event.sessionId);
      return;
    }
    const typed = call.payload === "1";
    this.contexts.bound(event.sessionId, call.executionContextId, typed);
    if (typed) this.armed(event.sessionId);
    this.notify();
  }

  private armed(session: string): void {
    const now = ++this.clock;
    const page = this.owners.get(session);
    if (page !== undefined) this.epochs.set(page, now);
    this.typedAt = now;
  }

  private adopt(page: string, session: string): void {
    this.owners.set(session, page);
    this.pages.get(page)?.sessions.add(session);
  }

  private forget(session: string): void {
    const owner = this.owners.get(session);
    const page = owner === undefined ? undefined : this.pages.get(owner);
    this.owners.delete(session);
    page?.sessions.delete(session);
    page?.pending.delete(session);
    this.contexts.drop(session);
    this.injected.delete(session);
    this.prepared.delete(session);
    this.scanner.forget(session);
  }

  private async attachPage(cdp: Cdp, id: string): Promise<void> {
    const page: Page = { sessions: new Set(), pending: new Set([id]) };
    this.pages.set(id, page);
    let session: string | undefined;
    const seen = await this.persist(
      cdp,
      `tab ${id}`,
      () => this.pages.get(id) === page,
      async () => {
        if (session === undefined) {
          const attached = await cdp.send("Target.attachToTarget", { targetId: id, flatten: true });
          session = words(record(attached), "sessionId");
          if (session === undefined) throw new Error("the tab did not attach");
          this.adopt(id, session);
        }
        await this.prepare(cdp, session);
      },
    );
    if (seen) page.pending.delete(id);
    this.notify();
  }

  private async prepareFrame(cdp: Cdp, pageId: string, session: string): Promise<void> {
    const seen = await this.persist(
      cdp,
      "a frame",
      () => this.owners.get(session) === pageId,
      () => this.prepare(cdp, session),
    );
    if (seen) this.pages.get(pageId)?.pending.delete(session);
    this.notify();
  }

  private async persist(
    cdp: Cdp,
    what: string,
    alive: () => boolean,
    work: () => Promise<void>,
  ): Promise<boolean> {
    while (cdp.open && alive()) {
      try {
        await work();
        return true;
      } catch (error) {
        console.error(`guard: cannot see ${what} yet, trying again: ${String(error)}`);
        await sleep(RETRY_MS);
      }
    }
    return false;
  }

  private async prepare(cdp: Cdp, sessionId: string): Promise<void> {
    const on = { sessionId };
    await cdp.send("Runtime.enable", {}, on);
    await cdp.send("Page.enable", {}, on);
    await cdp.send("Page.setLifecycleEventsEnabled", { enabled: true }, on);
    await cdp.send("Runtime.addBinding", { name: BINDING }, on);
    if (!this.injected.has(sessionId)) {
      await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: PAGE_SCRIPT }, on);
      this.injected.add(sessionId);
    }
    await cdp.send(
      "Target.setAutoAttach",
      { autoAttach: true, waitForDebuggerOnStart: false, flatten: true, filter: IFRAMES_ONLY },
      on,
    );
    for (const contextId of this.contexts.defaults(sessionId)) {
      const ran = record(
        await cdp.send("Runtime.evaluate", { expression: PAGE_SCRIPT, contextId }, on),
      );
      if (ran?.["exceptionDetails"] !== undefined) throw new Error("the page script did not run");
    }
    this.prepared.add(sessionId);
    await this.scanner.scan(cdp, sessionId);
  }
}
