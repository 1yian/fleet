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

export type BrowserInput =
  | {
      t: "mouse";
      type: "mouseMoved" | "mousePressed" | "mouseReleased";
      x: number;
      y: number;
      button: string;
      buttons: number;
      clickCount: number;
      modifiers: number;
    }
  | { t: "wheel"; x: number; y: number; deltaX: number; deltaY: number; modifiers: number }
  | {
      t: "key";
      type: "keyDown" | "rawKeyDown" | "keyUp";
      key: string;
      code: string;
      keyCode: number;
      text?: string;
      modifiers: number;
    };

type Pending = "take" | "done" | { readonly tab: string };
type Status = {
  readonly state?: BrowserState | undefined;
  readonly pending?: Pending | undefined;
  readonly notice?: string | undefined;
  readonly offline?: boolean | undefined;
  readonly fenced?: boolean | undefined;
  readonly halted?: boolean | undefined;
};

const LOST = "Control ended. You’re watching again.";
const AMBIGUOUS =
  "The last change may not have finished, so input and control changes are off. You can keep watching. Leave this page to hand control back to the agent.";

function commandFor(pending: Pending): BrowserCommand {
  if (pending === "take") return { t: "control", on: true };
  if (pending === "done") return { t: "done" };
  return { t: "tab", action: "activate", id: pending.tab };
}

function commandError(pending: Pending): string {
  if (pending === "take") return "Couldn’t take control. You’re still watching.";
  if (pending === "done") return "Couldn’t return control. Try Done again.";
  return "Couldn’t switch tabs. Try again.";
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
  private authority = 0;
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
    return state !== undefined && this.latest?.meta.targetId === state.activeTab;
  }

  private blocked(): boolean {
    return this.mutating || this.quarantined || this.recovering || !this.matched();
  }

  private accept(frame: BrowserFrame): void {
    const was = this.matched();
    this.latest = frame;
    this.frame(frame);
    if (was || !this.matched()) return;
    this.set(this.current);
    this.resume();
  }

  private resume(): void {
    if (this.closed || !this.recovering || !this.matched()) return;
    const epoch = this.epoch;
    void this.settle().then(() => {
      if (this.epoch !== epoch) return;
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
    const key = `${String(owns)}:${state.activeTab ?? ""}`;
    if (key !== this.confirmedKey) {
      this.confirmedKey = key;
      this.authority += 1;
      this.remote.clear();
    }
    this.set({
      state,
      pending: completed ? undefined : pending,
      notice: lost ? (pending === "done" ? "Control returned to the agent." : LOST) : notice,
    });
    this.resume();
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

  private canCommand(pending: Pending, state: BrowserState): boolean {
    return (
      !this.blocked() &&
      this.current.pending === undefined &&
      state.viewer.controlling === (pending !== "take")
    );
  }

  async command(pending: Pending): Promise<void> {
    const state = this.current.state;
    if (state === undefined || !this.canCommand(pending, state)) return;
    this.set({ state, pending });
    const ticket = ++this.ticket;
    await this.settle();
    if (this.ticket !== ticket) return;
    if (this.quarantined) {
      this.invalidateCommand();
      this.reopen(AMBIGUOUS);
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
    this.events.push(event);
    this.schedule();
  }

  private schedule(): void {
    if (this.closed || this.sending || this.scheduled || this.events.length === 0) return;
    this.scheduled = requestAnimationFrame(() => {
      this.scheduled = 0;
      this.flush();
    });
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
      this.set({ state: { ...state, viewer: { controlling: false } }, notice: LOST });
  }

  private send(): void {
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
          this.events.push(...this.remote.values());
        if (this.events.length === 0) return;
        this.send();
      }
    }
  }

  close(): void {
    this.closed = true;
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
