import { useCallback, useEffect, useRef, useState } from "react";
import {
  BrowserFrameSchema,
  BrowserStateSchema,
  check,
  type BrowserCommand,
  type BrowserFrame,
  type BrowserState,
} from "@fleet/protocol";
import { jsonEvent } from "./browser-api.ts";

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
    }
  | { t: "text"; text: string };

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

function orderTabs(state: BrowserState, previous: BrowserState | undefined): BrowserState {
  const positions = new Map(previous?.snapshot.tabs.map((tab, index) => [tab.id, index]));
  const position = (id: string): number => positions.get(id) ?? positions.size;
  const tabs = state.snapshot.tabs.toSorted((a, b) => position(a.id) - position(b.id));
  return { ...state, snapshot: { ...state.snapshot, tabs } };
}

class Viewer {
  private readonly suffix: string;
  private readonly source: EventSource;
  private current: Status = {};
  private closed = false;
  private ticket = 0;
  private confirmationTimer = 0;
  private events: BrowserInput[] = [];
  private scheduled = 0;
  private sending = false;

  private readonly lane: string;
  private readonly show: (status: Status) => void;

  constructor(lane: string, show: (status: Status) => void, frame: (frame: BrowserFrame) => void) {
    this.lane = lane;
    this.show = show;
    const viewer = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    this.suffix = `?viewer=${viewer}`;
    this.source = new EventSource(this.url("stream"));
    this.source.onerror = () => {
      this.invalidateCommand();
      this.events = [];
      this.set({ offline: true });
    };
    jsonEvent(
      this.source,
      "state",
      (raw) => check(BrowserStateSchema, raw),
      (state) => {
        this.confirm(state);
      },
    );
    jsonEvent(this.source, "frame", (raw) => check(BrowserFrameSchema, raw), frame);
  }

  private url(action: "stream" | "command" | "input"): string {
    return `/api/browser/lanes/${this.lane}/${action}${this.suffix}`;
  }

  private set(status: Status): void {
    if (this.closed) return;
    this.current = status;
    this.show(status);
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
    if (lost || previous?.activeTab !== state.activeTab) this.events = [];
    this.set({
      state: orderTabs(state, previous),
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
    this.events = [];
    this.set({ state, pending });
    const ticket = ++this.ticket;
    const unconfirmed = (): void => {
      if (this.ticket !== ticket) return;
      this.invalidateCommand();
      this.set({ state: this.current.state, notice: commandError(pending) });
    };
    const code = await this.post("command", commandFor(pending));
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
    this.schedule();
  }

  private schedule(): void {
    if (this.closed || this.sending || this.scheduled || this.events.length === 0) return;
    this.scheduled = requestAnimationFrame(() => {
      this.scheduled = 0;
      void this.flush();
    });
  }

  private async flush(): Promise<void> {
    if (!this.canDrive() || this.events.length === 0) return;
    this.sending = true;
    const ticket = this.ticket;
    const code = await this.post("input", { events: this.events.splice(0, 40) });
    this.sending = false;
    if (code === 409 && this.ticket === ticket && this.canDrive()) {
      this.events = [];
      const state = this.current.state;
      if (state !== undefined)
        this.set({ state: { ...state, viewer: { controlling: false } }, notice: LOST });
    }
    this.schedule();
  }

  close(): void {
    this.closed = true;
    this.invalidateCommand();
    this.events = [];
    cancelAnimationFrame(this.scheduled);
    if (this.current.state?.viewer.controlling) {
      void this.post("command", { t: "control", on: false }).finally(() => {
        this.source.close();
      });
    } else this.source.close();
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
