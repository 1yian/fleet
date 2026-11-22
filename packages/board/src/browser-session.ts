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
};

const LOST = "Control ended. You’re watching again.";

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
  private readonly held = new Map<string, BrowserInput>();
  private mutation: Promise<number> = Promise.resolve(0);
  private issuedTake = false;
  private scheduled = 0;
  private sending = false;
  private inflight: Promise<void> = Promise.resolve();

  private readonly lane: string;
  private readonly show: (status: Status) => void;

  constructor(lane: string, show: (status: Status) => void, frame: (frame: BrowserFrame) => void) {
    this.lane = lane;
    this.show = show;
    const viewer = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    this.suffix = `?viewer=${viewer}`;
    this.stream = openStream(this.url("stream"), {
      failed: () => {
        this.invalidateCommand();
        this.discard();
        this.set({ offline: true, notice: this.current.notice });
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
        jsonEvent(source, "frame", (raw) => check(BrowserFrameSchema, raw), frame);
      },
    });
  }

  private url(action: "stream" | "command" | "input"): string {
    return `/api/browser/lanes/${this.lane}/${action}${this.suffix}`;
  }

  private set(status: Status): void {
    if (this.closed) return;
    this.current = status;
    this.show(status);
  }

  private discard(): void {
    this.events = [];
    this.held.clear();
  }

  private track(event: BrowserInput): void {
    if (event.t === "key") {
      const id = `key:${event.code}`;
      if (event.type === "keyUp") this.held.delete(id);
      else
        this.held.set(id, {
          t: "key",
          type: "keyUp",
          key: event.key,
          code: event.code,
          keyCode: event.keyCode,
          modifiers: 0,
        });
    } else if (event.t === "mouse" && event.type !== "mouseMoved") {
      const id = `mouse:${event.button}`;
      if (event.type === "mouseReleased") this.held.delete(id);
      else this.held.set(id, { ...event, type: "mouseReleased", buttons: 0 });
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
    if (lost || previous?.activeTab !== state.activeTab) this.discard();
    this.set({
      state,
      pending: completed ? undefined : pending,
      notice: lost ? (pending === "done" ? "Control returned to the agent." : LOST) : notice,
    });
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

  async command(pending: Pending): Promise<void> {
    const state = this.current.state;
    if (
      state === undefined ||
      this.current.pending !== undefined ||
      state.viewer.controlling !== (pending !== "take")
    )
      return;
    this.set({ state, pending });
    const ticket = ++this.ticket;
    const unconfirmed = (): void => {
      if (this.ticket !== ticket) return;
      this.invalidateCommand();
      this.discard();
      this.set({ offline: true, notice: commandError(pending) });
      this.stream.restart();
    };
    await this.settle();
    if (this.ticket !== ticket) return;
    if (pending === "take") this.issuedTake = true;
    const posting = this.post("command", commandFor(pending));
    this.mutation = posting;
    const code = await posting;
    if (this.ticket !== ticket) return;
    if (code === 204) this.confirmationTimer = window.setTimeout(unconfirmed, 5000);
    else unconfirmed();
  }

  private canDrive(): boolean {
    return (
      !this.closed &&
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
    this.track(event);
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

  private send(): void {
    this.sending = true;
    const ticket = this.ticket;
    this.inflight = this.post("input", { events: this.events.splice(0, 40) }).then((code) => {
      this.sending = false;
      if (code === 409 && this.ticket === ticket && this.canDrive()) {
        this.discard();
        const state = this.current.state;
        if (state !== undefined)
          this.set({ state: { ...state, viewer: { controlling: false } }, notice: LOST });
      }
      this.schedule();
    });
  }

  private async settle(): Promise<void> {
    this.events.push(...this.held.values());
    this.held.clear();
    while (this.events.length > 0 || this.sending) {
      if (!this.sending) this.send();
      await this.inflight;
    }
  }

  close(): void {
    this.closed = true;
    this.invalidateCommand();
    cancelAnimationFrame(this.scheduled);
    void this.teardown(this.current.state?.viewer.controlling === true);
  }

  private async teardown(controlling: boolean): Promise<void> {
    await this.settle();
    await this.mutation;
    if (controlling || this.issuedTake) await this.post("command", { t: "control", on: false });
    this.stream.close();
  }
}

export function useBrowserViewer(lane: string) {
  const [status, setStatus] = useState<Status>({});
  const [frame, setFrame] = useState<BrowserFrame>();
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
