import { useCallback, useEffect, useRef, useState } from "react";
import {
  BrowserFrameSchema,
  BrowserStateSchema,
  check,
  type BrowserCommand,
  type BrowserFrame,
  type BrowserState,
} from "@fleet/protocol";
import { jsonEvent, openStream, type Stream } from "./browser-api.ts";
import {
  AMBIGUOUS,
  CHANGED,
  LOST,
  commandError,
  commandFor,
  type BrowserInput,
  type Pending,
  type Status,
} from "./browser-commands.ts";

const FRESH_FRAME_MS = 3000;

function looseCommand(pending: Pending, fresh: boolean): boolean {
  return fresh || pending === "take";
}

class Viewer {
  private readonly suffix: string;
  private readonly stream: Stream;
  private current: Status = {};
  private closed = false;
  private ticket = 0;
  private confirmationTimer = 0;
  private events: BrowserInput[] = [];
  private readonly remote = new Map<string, BrowserInput>();
  private mutation: Promise<number> = Promise.resolve(0);
  private mutating = false;
  private quarantined = false;
  private recovering = false;
  private latest: BrowserFrame | undefined;
  private trusted = false;
  private freshTimer = 0;
  private attempted = "";
  private authority = 0;
  private frames = 0;
  private queuedStamp = "";
  private confirmedKey: string | undefined;
  private epoch = 0;
  private issuedTake = false;
  private scheduled = 0;
  private sending = false;
  private inflight: Promise<void> = Promise.resolve();

  private readonly lane: string;
  private readonly show: (status: Status) => void;
  private readonly frame: (frame: BrowserFrame | undefined) => void;

  constructor(
    lane: string,
    show: (status: Status) => void,
    frame: (frame: BrowserFrame | undefined) => void,
  ) {
    this.lane = lane;
    this.show = show;
    this.frame = frame;
    const viewer = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    this.suffix = `?viewer=${viewer}`;
    this.stream = openStream(this.url("stream"), {
      failed: () => {
        this.epoch += 1;
        this.latest = undefined;
        this.frame(undefined);
        this.events = [];
        this.recovering = true;
        if (!this.mutating) this.invalidateCommand();
        this.set({
          offline: true,
          pending: this.mutating ? this.current.pending : undefined,
          notice: this.current.notice,
        });
      },
      wire: (source, ready) => {
        jsonEvent(
          source,
          "state",
          (raw) => check(BrowserStateSchema, raw),
          (state) => {
            ready();
            this.confirm(state);
          },
        );
        jsonEvent(
          source,
          "frame",
          (raw) => check(BrowserFrameSchema, raw),
          (frame) => {
            this.accept(frame);
          },
        );
      },
    });
  }

  private url(action: "stream" | "command" | "input"): string {
    return `/api/browser/lanes/${this.lane}/${action}${this.suffix}`;
  }

  private set(status: Status): void {
    this.current = status;
    if (!this.closed) this.show({ ...status, fenced: this.blocked(), halted: this.quarantined });
  }

  private matched(): boolean {
    const state = this.current.state;
    if (state === undefined) return false;
    if (state.activeTab === null) return true;
    return this.trusted && this.latest?.meta.targetId === state.activeTab;
  }

  private blocked(): boolean {
    return this.mutating || this.quarantined || this.recovering || !this.matched();
  }

  private accept(frame: BrowserFrame): void {
    const was = this.matched();
    this.latest = frame;
    this.trusted = this.current.state?.activeTab === frame.meta.targetId;
    this.frame(frame);
    const now = this.matched();
    if (was && !now) {
      this.frames += 1;
      this.events = [];
      this.recovering = true;
    }
    if (was === now) return;
    this.set(this.current);
    if (now) this.resume();
  }

  private resume(): void {
    if (this.closed || !this.recovering || !this.matched()) return;
    const epoch = this.epoch;
    const frames = this.frames;
    void this.settle().then(() => {
      if (this.epoch !== epoch || this.frames !== frames || !this.matched()) return;
      this.recovering = false;
      this.set(this.current);
    });
  }

  private reopen(notice: string | undefined): void {
    this.epoch += 1;
    this.latest = undefined;
    this.frame(undefined);
    this.discard();
    this.set({ offline: true, notice });
    this.stream.restart();
  }

  private discard(): void {
    this.events = [];
    this.remote.clear();
  }

  private track(event: BrowserInput): void {
    if (event.t === "key") {
      const id = `key:${event.code}`;
      if (event.type === "keyUp") this.remote.delete(id);
      else
        this.remote.set(id, {
          t: "key",
          type: "keyUp",
          key: event.key,
          code: event.code,
          keyCode: event.keyCode,
          modifiers: 0,
        });
    } else if (event.t === "mouse" && event.type !== "mouseMoved") {
      const id = `mouse:${event.button}`;
      if (event.type === "mouseReleased") this.remote.delete(id);
      else this.remote.set(id, { ...event, type: "mouseReleased", buttons: 0 });
    }
  }

  private invalidateCommand(): void {
    clearTimeout(this.confirmationTimer);
    this.ticket += 1;
  }

  private confirm(state: BrowserState): void {
    const { state: previous, pending, notice } = this.current;
    const owns = state.viewer.controlling;
    const lost = previous?.viewer.controlling === true && !owns;
    const completed =
      lost ||
      (pending === "take" && owns) ||
      (pending === "done" && !owns) ||
      (typeof pending === "object" && pending.tab === state.activeTab);
    if (completed) this.invalidateCommand();
    if (!owns && pending !== "take") this.issuedTake = false;
    if (lost || previous?.activeTab !== state.activeTab) this.events = [];
    if (this.latest !== undefined && this.latest.meta.targetId !== state.activeTab) {
      this.latest = undefined;
      this.frame(undefined);
    }
    const key = `${String(owns)}:${state.activeTab ?? ""}`;
    if (key !== this.confirmedKey) {
      this.confirmedKey = key;
      this.authority += 1;
      this.events = [];
      this.remote.clear();
    }
    this.set({
      state,
      pending: completed ? undefined : pending,
      notice: lost ? (pending === "done" ? "Control returned to the agent." : LOST) : notice,
    });
    this.resume();
    this.wantFrame();
  }

  private async post(
    action: "command" | "input",
    body: BrowserCommand | { events: BrowserInput[] },
  ): Promise<number> {
    try {
      const response = await fetch(this.url(action), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(12_000),
      });
      return response.status;
    } catch {
      return 0;
    }
  }

  private canCommand(pending: Pending, state: BrowserState, loose: boolean): boolean {
    return (
      (loose ? !this.mutating && !this.quarantined : !this.blocked()) &&
      this.current.pending === undefined &&
      state.viewer.controlling === (pending !== "take")
    );
  }

  private wantFrame(): void {
    const state = this.current.state;
    if (this.closed || state === undefined || this.matched()) return;
    if (!state.viewer.controlling || state.activeTab === null) return;
    const stamp = `${String(this.epoch)}.${String(this.authority)}`;
    if (this.attempted === stamp) return;
    clearTimeout(this.freshTimer);
    this.freshTimer = window.setTimeout(() => {
      const tab = this.current.state?.activeTab;
      const same = stamp === `${String(this.epoch)}.${String(this.authority)}`;
      if (tab === undefined || tab === null || !same || this.matched()) return;
      this.attempted = stamp;
      void this.command({ tab }, true);
    }, FRESH_FRAME_MS);
  }

  async command(pending: Pending, fresh = false): Promise<void> {
    const state = this.current.state;
    const loose = looseCommand(pending, fresh);
    if (state === undefined || !this.canCommand(pending, state, loose)) return;
    this.set({ state, pending });
    const ticket = ++this.ticket;
    const stamp = this.stamp();
    await this.settle();
    if (this.ticket !== ticket) return;
    if (this.quarantined) {
      this.invalidateCommand();
      this.reopen(AMBIGUOUS);
      return;
    }
    if (this.stamp() !== stamp || (!loose && !this.matched())) {
      this.invalidateCommand();
      this.set({ state: this.current.state, notice: CHANGED });
      return;
    }
    if (pending === "take") this.issuedTake = true;
    const epoch = this.epoch;
    const code = await this.mutate(pending);
    this.resolve(pending, ticket, epoch, code);
  }

  private async mutate(pending: Pending): Promise<number> {
    this.mutating = true;
    const posting = this.post("command", commandFor(pending));
    this.mutation = posting;
    const code = await posting;
    this.mutating = false;
    if (code !== 204 && code !== 409) this.quarantined = true;
    return code;
  }

  private unconfirmed(pending: Pending, ticket: number): void {
    if (this.ticket !== ticket) return;
    this.invalidateCommand();
    this.reopen(commandError(pending));
  }

  private fence(notice: string): void {
    this.quarantined = true;
    this.discard();
    this.set({ ...this.current, notice });
  }

  private resolve(pending: Pending, ticket: number, epoch: number, code: number): void {
    if (this.closed) return;
    const ambiguous = code !== 204 && code !== 409;
    if (ambiguous || this.epoch !== epoch) {
      this.invalidateCommand();
      this.reopen(
        ambiguous ? AMBIGUOUS : code === 409 ? commandError(pending) : this.current.notice,
      );
    } else if (this.ticket !== ticket) this.set(this.current);
    else if (code === 204)
      this.confirmationTimer = window.setTimeout(() => {
        this.unconfirmed(pending, ticket);
      }, 5000);
    else this.unconfirmed(pending, ticket);
  }

  private canDrive(): boolean {
    return (
      !this.closed &&
      !this.blocked() &&
      this.current.pending === undefined &&
      this.current.state?.viewer.controlling === true
    );
  }

  input(target: string, event: BrowserInput): void {
    if (!this.canDrive() || this.current.state?.activeTab !== target) return;
    const last = this.events.at(-1);
    if (
      last?.t === "mouse" &&
      last.type === "mouseMoved" &&
      event.t === "mouse" &&
      event.type === "mouseMoved"
    )
      this.events.pop();
    this.enqueue([event]);
    this.schedule();
  }

  private schedule(): void {
    if (this.closed || this.sending || this.scheduled || this.events.length === 0) return;
    this.scheduled = requestAnimationFrame(() => {
      this.scheduled = 0;
      this.flush();
    });
  }

  private stamp(): string {
    return `${String(this.authority)}.${String(this.frames)}`;
  }

  private enqueue(events: BrowserInput[]): void {
    if (this.events.length === 0) this.queuedStamp = this.stamp();
    this.events.push(...events);
  }

  private deliverable(): boolean {
    return (
      this.queuedStamp === this.stamp() &&
      !this.mutating &&
      this.matched() &&
      this.current.state?.viewer.controlling === true
    );
  }

  private flush(): void {
    if (!this.sending && this.events.length > 0) this.send();
  }

  private acknowledge(batch: BrowserInput[], code: number, authority: number): void {
    if (code === 204 && this.authority === authority) for (const event of batch) this.track(event);
  }

  private refused(authority: number): void {
    if (this.authority !== authority) return;
    this.authority += 1;
    this.issuedTake = false;
    this.discard();
    this.invalidateCommand();
    const state = this.current.state;
    if (state !== undefined)
      this.current = { ...this.current, state: { ...state, viewer: { controlling: false } } };
    if (!this.closed) this.reopen(LOST);
  }

  private send(): void {
    if (!this.deliverable()) {
      this.events = [];
      return;
    }
    this.sending = true;
    const authority = this.authority;
    const batch = this.events.splice(0, 40);
    this.inflight = this.post("input", { events: batch }).then((code) => {
      this.sending = false;
      this.acknowledge(batch, code, authority);
      if (code !== 204 && code !== 409) this.fence(AMBIGUOUS);
      if (code === 409) this.refused(authority);
      this.schedule();
    });
  }

  private authorised(epoch: number): boolean {
    return (
      this.epoch === epoch &&
      !this.mutating &&
      this.matched() &&
      this.current.state?.viewer.controlling === true
    );
  }

  private async settle(): Promise<void> {
    const epoch = this.epoch;
    while (!this.quarantined) {
      if (this.sending) await this.inflight;
      else {
        if (this.events.length === 0 && this.authorised(epoch))
          this.enqueue([...this.remote.values()]);
        if (this.events.length === 0) return;
        this.send();
      }
    }
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.freshTimer);
    this.invalidateCommand();
    cancelAnimationFrame(this.scheduled);
    void this.teardown();
  }

  private async teardown(): Promise<void> {
    await this.settle();
    await this.mutation;
    if (
      !this.quarantined &&
      !this.recovering &&
      (this.current.state?.viewer.controlling === true || this.issuedTake)
    )
      await this.post("command", { t: "control", on: false });
    this.stream.close();
  }
}

export function useBrowserViewer(lane: string) {
  const [status, setStatus] = useState<Status>({});
  const [frame, setFrame] = useState<BrowserFrame | undefined>();
  const viewer = useRef<Viewer>(null);
  useEffect(() => {
    const next = new Viewer(lane, setStatus, setFrame);
    viewer.current = next;
    return () => {
      viewer.current = null;
      next.close();
    };
  }, [lane]);
  const command = useCallback((pending: Pending) => {
    void viewer.current?.command(pending);
  }, []);
  const input = useCallback((target: string, event: BrowserInput) => {
    viewer.current?.input(target, event);
  }, []);
  return { status, frame, command, input };
}
