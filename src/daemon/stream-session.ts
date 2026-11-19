import type { ServerResponse } from "node:http";
import type { FrameMeta, StreamCommand, StreamInput } from "../shared/protocol.js";
import { CdpClient } from "./cdp.js";
import { HttpError } from "./errors.js";
import type { Lane } from "./lane.js";

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function parseInput(raw: unknown): StreamInput | null {
  if (typeof raw !== "object" || raw === null) return null;
  const e = raw as Record<string, unknown>;
  switch (e.t) {
    case "mouse":
      return (e.type === "mouseMoved" || e.type === "mousePressed" || e.type === "mouseReleased") &&
        finite(e.x) &&
        finite(e.y) &&
        (e.button === "none" || e.button === "left" || e.button === "middle" || e.button === "right") &&
        finite(e.buttons) &&
        finite(e.clickCount) &&
        finite(e.modifiers)
        ? (e as unknown as StreamInput)
        : null;
    case "wheel":
      return finite(e.x) && finite(e.y) && finite(e.deltaX) && finite(e.deltaY) && finite(e.modifiers)
        ? (e as unknown as StreamInput)
        : null;
    case "key":
      return (e.type === "keyDown" || e.type === "keyUp" || e.type === "rawKeyDown") &&
        typeof e.key === "string" &&
        typeof e.code === "string" &&
        finite(e.keyCode) &&
        finite(e.modifiers)
        ? (e as unknown as StreamInput)
        : null;
    case "text":
      return typeof e.text === "string" ? (e as unknown as StreamInput) : null;
    default:
      return null;
  }
}

export function parseCommand(raw: unknown): StreamCommand | null {
  if (typeof raw !== "object" || raw === null) return null;
  const c = raw as Record<string, unknown>;
  switch (c.t) {
    case "control":
      return typeof c.on === "boolean" ? { t: "control", on: c.on, force: c.force === true } : null;
    case "viewport":
      if (c.reset === true) return { t: "viewport", reset: true };
      return finite(c.width) &&
        finite(c.height) &&
        c.width >= 200 &&
        c.width <= 3840 &&
        c.height >= 200 &&
        c.height <= 2400
        ? {
            t: "viewport",
            width: Math.round(c.width),
            height: Math.round(c.height),
            deviceScaleFactor: finite(c.deviceScaleFactor)
              ? Math.max(1, Math.min(4, c.deviceScaleFactor))
              : 1,
            mobile: c.mobile === true,
          }
        : null;
    case "navigate":
      return typeof c.url === "string" ? { t: "navigate", url: c.url } : null;
    case "history":
      return c.direction === "back" || c.direction === "forward"
        ? { t: "history", direction: c.direction }
        : null;
    case "reload":
      return { t: "reload" };
    case "done":
      return { t: "done" };
    case "tab":
      return c.action === "activate" || c.action === "close" || c.action === "new"
        ? { t: "tab", action: c.action, id: typeof c.id === "string" ? c.id : undefined }
        : null;
    default:
      return null;
  }
}

export function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

interface PendingFrame {
  data: string;
  chromeSessionId: string;
  meta: FrameMeta;
}

export interface StreamOptions {
  maxWidth: number;
  quality: number;
}

export class StreamSession {
  readonly viewerId: string;
  private readonly res: ServerResponse;
  private readonly lane: Lane;
  private readonly options: StreamOptions;
  private cdp: CdpClient | null = null;
  private pageSessionId: string | undefined;
  private targetId: string | undefined;
  private pushTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private disposed = false;
  private writing = false;
  private pending: PendingFrame | null = null;
  private seq = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private viewport: Extract<StreamCommand, { t: "viewport"; width: number }> | null = null;
  private readonly onLaneChange = (): void => {
    if (this.viewport && !this.holdsControl()) void this.clearViewport();
    this.schedulePush();
  };
  private readonly onActivate = (targetId: string): void => {
    if (targetId !== this.targetId) void this.switchTo(targetId).catch(() => undefined);
  };

  constructor(res: ServerResponse, lane: Lane, viewerId: string, options: StreamOptions) {
    this.res = res;
    this.lane = lane;
    this.viewerId = viewerId;
    this.options = options;
  }

  async start(): Promise<void> {
    this.res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    this.res.write(": connected\n\n");
    this.pingTimer = setInterval(() => this.res.write(": ping\n\n"), 15_000);
    this.res.on("close", () => this.dispose());
    await this.lane.start();
    this.lane.on("change", this.onLaneChange);
    this.lane.on("activate", this.onActivate);
    const cdp = await CdpClient.connect(await this.lane.browserWsUrl());
    if (this.disposed) {
      cdp.close();
      return;
    }
    this.cdp = cdp;
    cdp.onClosed(() => {
      if (!this.disposed) {
        this.notice("the lane's browser connection closed; reconnect the stream");
        this.res.end();
      }
    });
    cdp.on("Target.targetCreated", (params) => {
      const info = params.targetInfo as { targetId: string; type: string } | undefined;
      if (info?.type === "page" && info.targetId !== this.targetId)
        void this.switchTo(info.targetId).catch(() => undefined);
      this.schedulePush();
    });
    cdp.on("Target.targetDestroyed", (params) => {
      if (params.targetId === this.targetId) void this.pickInitialTarget().catch(() => undefined);
      this.schedulePush();
    });
    cdp.on("Target.targetInfoChanged", () => this.schedulePush());
    cdp.on("Page.screencastFrame", (params, sessionId) => this.onFrame(params, sessionId));
    await cdp.send("Target.setDiscoverTargets", { discover: true });
    await this.pickInitialTarget();
    this.schedulePush();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.lane.off("change", this.onLaneChange);
    this.lane.off("activate", this.onActivate);
    if (this.lane.streams.get(this.viewerId) === this) this.lane.streams.delete(this.viewerId);
    if (this.pushTimer) clearTimeout(this.pushTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.cdp?.close();
    this.lane.viewerGone(this.viewerId, 45_000);
    if (!this.res.writableEnded) this.res.end();
  }

  private holdsControl(): boolean {
    return this.lane.control.kind === "human" && this.lane.control.viewerId === this.viewerId;
  }

  private async clearViewport(): Promise<void> {
    this.viewport = null;
    if (this.cdp && this.pageSessionId)
      await this.cdp
        .send("Emulation.clearDeviceMetricsOverride", {}, this.pageSessionId)
        .catch(() => undefined);
  }

  private requireControl(): void {
    if (!this.holdsControl()) {
      throw new HttpError(409, "this viewer does not hold control; send {t:'control', on:true} first");
    }
    if (!this.cdp || !this.pageSessionId) throw new HttpError(409, "no active page in the stream yet");
  }

  input(events: StreamInput[]): Promise<number> {
    this.requireControl();
    const run = this.queue.then(async () => {
      for (const event of events) await this.apply(event);
      return events.length;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  async command(command: StreamCommand): Promise<void> {
    if (command.t === "control") {
      if (command.on) {
        if (this.lane.currentStep) {
          throw new HttpError(
            409,
            this.lane.currentStep === "credentials"
              ? "the agent is typing credentials into this lane right now; try again in a few seconds"
              : "the agent is solving a captcha on this lane right now; try again in a few seconds",
          );
        }
        if (!this.lane.takeControl(this.viewerId, command.force)) {
          throw new HttpError(
            409,
            "another viewer holds control of this lane; send force:true to take it over",
          );
        }
      } else {
        this.lane.releaseControl(this.viewerId);
        await this.clearViewport();
      }
      return;
    }
    if (command.t === "done") {
      const handoff = this.lane.handoff;
      if (handoff?.status === "open") this.lane.resolveHandoff(handoff.id, "done");
      else this.lane.releaseControl(this.viewerId);
      await this.clearViewport();
      return;
    }
    this.requireControl();
    await this.perform(command);
  }

  private async apply(event: StreamInput): Promise<void> {
    const cdp = this.cdp;
    const session = this.pageSessionId;
    if (!cdp || !session) return;
    switch (event.t) {
      case "mouse":
        await cdp.send(
          "Input.dispatchMouseEvent",
          {
            type: event.type,
            x: event.x,
            y: event.y,
            button: event.button,
            buttons: event.buttons,
            clickCount: event.clickCount,
            modifiers: event.modifiers,
          },
          session,
        );
        return;
      case "wheel":
        await cdp.send(
          "Input.dispatchMouseEvent",
          {
            type: "mouseWheel",
            x: event.x,
            y: event.y,
            deltaX: event.deltaX,
            deltaY: event.deltaY,
            modifiers: event.modifiers,
          },
          session,
        );
        return;
      case "key": {
        const params: Record<string, unknown> = {
          type: event.type,
          key: event.key,
          code: event.code,
          windowsVirtualKeyCode: event.keyCode,
          nativeVirtualKeyCode: event.keyCode,
          modifiers: event.modifiers,
        };
        if (event.text) {
          params.text = event.text;
          params.unmodifiedText = event.text;
        }
        if (event.commands?.length) params.commands = event.commands;
        await cdp.send("Input.dispatchKeyEvent", params, session);
        return;
      }
      case "text":
        await cdp.send("Input.insertText", { text: event.text }, session);
        return;
    }
  }

  private async perform(command: StreamCommand): Promise<void> {
    const cdp = this.cdp;
    const session = this.pageSessionId;
    if (!cdp || !session) return;
    switch (command.t) {
      case "viewport":
        if ("reset" in command) await this.clearViewport();
        else {
          this.viewport = command;
          await this.applyViewport(session);
        }
        return;
      case "navigate":
        await cdp.send("Page.navigate", { url: normalizeUrl(command.url) }, session);
        return;
      case "reload":
        await cdp.send("Page.reload", {}, session);
        return;
      case "history": {
        const history = await cdp.send<{ currentIndex: number; entries: Array<{ id: number }> }>(
          "Page.getNavigationHistory",
          {},
          session,
        );
        const entry = history.entries[history.currentIndex + (command.direction === "back" ? -1 : 1)];
        if (entry) await cdp.send("Page.navigateToHistoryEntry", { entryId: entry.id }, session);
        return;
      }
      case "tab":
        if (command.action === "new") await cdp.send("Target.createTarget", { url: "about:blank" });
        else if (command.action === "activate" && command.id) {
          await cdp.send("Target.activateTarget", { targetId: command.id });
          await this.switchTo(command.id);
        } else if (command.action === "close" && command.id)
          await cdp.send("Target.closeTarget", { targetId: command.id });
        return;
      default:
        return;
    }
  }

  private async applyViewport(session: string): Promise<void> {
    const viewport = this.viewport;
    if (!viewport || !this.cdp) return;
    await this.cdp.send(
      "Emulation.setDeviceMetricsOverride",
      {
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor: viewport.deviceScaleFactor ?? 1,
        mobile: viewport.mobile ?? false,
      },
      session,
    );
  }

  private async pickInitialTarget(): Promise<void> {
    const tabs = await this.lane.tabs();
    const preferred = tabs.find((tab) => tab.id === this.lane.activeTarget) ?? tabs[0];
    if (preferred) await this.switchTo(preferred.id);
  }

  private async switchTo(targetId: string): Promise<void> {
    const cdp = this.cdp;
    if (!cdp || this.disposed) return;
    if (this.pageSessionId) {
      await cdp.send("Page.stopScreencast", {}, this.pageSessionId).catch(() => undefined);
      await cdp.send("Target.detachFromTarget", { sessionId: this.pageSessionId }).catch(() => undefined);
    }
    this.pageSessionId = undefined;
    this.pending = null;
    this.targetId = targetId;
    const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    this.pageSessionId = sessionId;
    await cdp.send("Page.enable", {}, sessionId);
    await this.applyViewport(sessionId);
    await cdp.send(
      "Page.startScreencast",
      {
        format: "jpeg",
        quality: this.options.quality,
        maxWidth: this.options.maxWidth,
        maxHeight: this.lane.screenHeight,
        everyNthFrame: 1,
      },
      sessionId,
    );
    this.schedulePush();
  }

  private onFrame(params: Record<string, unknown>, sessionId: string | undefined): void {
    if (!this.cdp || sessionId !== this.pageSessionId || !this.targetId) return;
    const meta = params.metadata as Omit<FrameMeta, "targetId">;
    const frame: PendingFrame = {
      data: String(params.data),
      chromeSessionId: String(params.sessionId),
      meta: { ...meta, targetId: this.targetId },
    };
    if (this.writing) {
      if (this.pending) this.ack(this.pending);
      this.pending = frame;
      return;
    }
    this.write(frame);
  }

  private write(frame: PendingFrame): void {
    this.writing = true;
    this.seq += 1;
    const payload = `event: frame\ndata: {"seq":${this.seq},"meta":${JSON.stringify(frame.meta)},"jpeg":"${frame.data}"}\n\n`;
    this.res.write(payload, () => {
      this.writing = false;
      this.ack(frame);
      const next = this.pending;
      this.pending = null;
      if (next && !this.disposed) this.write(next);
    });
  }

  private ack(frame: PendingFrame): void {
    const session = this.pageSessionId;
    if (!this.cdp || !session) return;
    void this.cdp
      .send("Page.screencastFrameAck", { sessionId: Number(frame.chromeSessionId) }, session)
      .catch(() => undefined);
  }

  private schedulePush(): void {
    if (this.pushTimer || this.disposed) return;
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null;
      void this.pushState();
    }, 80);
  }

  private async pushState(): Promise<void> {
    if (this.disposed) return;
    const snapshot = await this.lane.snapshot();
    const controlling = this.lane.control.kind === "human" && this.lane.control.viewerId === this.viewerId;
    this.res.write(
      `event: state\ndata: ${JSON.stringify({ snapshot, activeTab: this.targetId ?? null, viewer: { id: this.viewerId, controlling } })}\n\n`,
    );
  }

  private notice(text: string): void {
    if (!this.res.writableEnded) this.res.write(`event: notice\ndata: ${JSON.stringify({ text })}\n\n`);
  }
}
