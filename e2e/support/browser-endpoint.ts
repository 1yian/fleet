import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { check, BrowserCommandSchema } from "@fleet/protocol";

const TABS = [
  { id: "one", title: "Garden" },
  { id: "two", title: "Workshop" },
];
export const REASON = "Choose a delivery option";

function event(response: ServerResponse, name: string, data: unknown): void {
  response.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
}

export class BrowserEndpoint {
  readonly token = randomBytes(32).toString("hex");
  private readonly feeds = new Set<ServerResponse>();
  private readonly viewers = new Map<string, ServerResponse>();
  private holder: string | undefined;
  private requested: string | undefined;
  private asking = false;
  private tab = 0;
  private outage = false;
  private withholding = false;
  activeInputs = 0;
  rejected = 0;
  streamOpens = 0;
  arrivals = 0;
  private failing = false;
  private failingInput = false;
  private refusing = false;
  private granting = false;
  granted = 0;
  private frameHeld = false;
  private tabless = false;
  private frameFirst = false;
  readonly order: string[] = [];
  readonly events: Record<string, unknown>[] = [];
  readonly commands: unknown[] = [];
  private gate: Promise<void> | undefined;
  private open: (() => void) | undefined;
  private replyGate: Promise<void> | undefined;
  private replyOpen: (() => void) | undefined;
  activeInputsAtTab = -1;
  readonly server = createServer((request, response) => {
    void this.answer(request, response).catch(() => {
      response.writeHead(500).end();
    });
  });

  private readonly jpeg: readonly string[];

  constructor(jpeg: readonly string[]) {
    this.jpeg = jpeg;
  }

  private lane() {
    return {
      lane: "garden",
      status: "ready",
      tabs: this.tabless ? [] : TABS,
      control: { kind: this.holder === undefined ? "agent" : "human" },
      credentialStep: false,
      captchaStep: false,
      handoff: this.asking ? { reason: REASON, status: "open" } : null,
      viewLink: "http://retired.invalid:7878/#/browser/garden",
    };
  }

  private state(viewer: string, response: ServerResponse): void {
    const activeTab = this.tabless ? null : TABS[this.tab]?.id;
    if (this.frameFirst && !this.frameHeld && !this.tabless) this.frame(response);
    event(response, "state", {
      snapshot: this.lane(),
      activeTab,
      viewer: { controlling: this.holder === viewer },
    });
    if (!this.frameFirst && !this.frameHeld && !this.tabless) this.frame(response);
  }

  private frame(response: ServerResponse): void {
    event(response, "frame", {
      jpeg: this.jpeg[this.tab],
      meta: { targetId: TABS[this.tab]?.id, deviceWidth: 480, deviceHeight: 300 },
    });
  }

  holdFrame(): void {
    this.frameHeld = true;
  }

  releaseFrame(): void {
    this.frameHeld = false;
    for (const response of this.viewers.values()) this.frame(response);
  }

  private publish(): void {
    for (const feed of this.feeds) event(feed, "lane", this.lane());
    if (this.withholding) return;
    for (const [viewer, response] of this.viewers) this.state(viewer, response);
  }

  hold(): void {
    this.gate = new Promise<void>((resolve) => {
      this.open = resolve;
    });
  }

  release(): void {
    this.open?.();
    this.gate = undefined;
  }

  holdReply(): void {
    this.replyGate = new Promise<void>((resolve) => {
      this.replyOpen = resolve;
    });
  }

  releaseReply(): void {
    this.replyOpen?.();
    this.replyGate = undefined;
  }

  releaseAndHold(): void {
    this.release();
    this.hold();
  }

  ask(): void {
    this.asking = true;
    this.publish();
  }

  confirm(): void {
    assert.ok(this.requested);
    this.holder = this.requested;
    this.publish();
  }

  revoke(): void {
    this.holder = "second-viewer";
    this.publish();
  }

  startOutage(): void {
    this.outage = true;
    for (const response of [...this.feeds, ...this.viewers.values()]) response.destroy();
  }

  endOutage(): void {
    this.outage = false;
  }

  failNextCommand(): void {
    this.failing = true;
  }

  refuseNextInput(): void {
    this.refusing = true;
  }

  failNextInput(): void {
    this.failingInput = true;
  }

  get streams(): number {
    return this.viewers.size;
  }

  showFrame(index: number): void {
    for (const response of this.viewers.values())
      event(response, "frame", {
        jpeg: this.jpeg[index],
        meta: { targetId: TABS[index]?.id, deviceWidth: 480, deviceHeight: 300 },
      });
  }

  sendFrameBeforeState(): void {
    this.frameFirst = true;
  }

  closeAllTabs(): void {
    this.tabless = true;
    this.publish();
  }

  grantOnTake(): void {
    this.granting = true;
  }

  get controlled(): boolean {
    return this.holder !== undefined;
  }

  switchTab(index = 1): void {
    this.tab = index;
    this.publish();
  }

  moveTab(): void {
    this.tab = 1;
  }

  withholdState(): void {
    this.withholding = true;
  }

  releaseState(): void {
    this.withholding = false;
    this.publish();
  }

  private begin(response: ServerResponse): void {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.flushHeaders();
  }

  private async answer(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.headers.authorization !== `Bearer ${this.token}`) {
      response.writeHead(401).end();
      return;
    }
    const url = new URL(request.url ?? "/", "http://fixture");
    const viewer = url.searchParams.get("viewer") ?? "";
    if (this.outage && (url.pathname === "/v1/events" || url.pathname.endsWith("/stream"))) {
      this.rejected += 1;
      response.writeHead(503).end();
      return;
    }
    if (url.pathname === "/v1/events") {
      this.begin(response);
      this.feeds.add(response);
      response.once("close", () => this.feeds.delete(response));
      event(response, "lane", this.lane());
    } else if (url.pathname.endsWith("/stream")) {
      this.begin(response);
      this.viewers.set(viewer, response);
      this.streamOpens += 1;
      response.once("close", () => {
        if (this.viewers.get(viewer) === response) this.viewers.delete(viewer);
      });
      if (!this.withholding) this.state(viewer, response);
    } else {
      await this.mutate(url, viewer, request, response);
    }
  }

  private async mutate(
    url: URL,
    viewer: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    request.setEncoding("utf8");
    let raw = "";
    for await (const chunk of request) {
      if (typeof chunk === "string") raw += chunk;
    }
    const body: unknown = JSON.parse(raw);
    if (url.pathname.endsWith("/command")) {
      this.arrivals += 1;
      await this.gate;
      this.command(viewer, body);
      await this.replyGate;
      if (this.failing) {
        this.failing = false;
        response.writeHead(500).end();
        return;
      }
    } else if (this.holder !== viewer) {
      response.writeHead(409).end("viewer does not hold control, send control first");
      return;
    } else {
      await this.input(body);
      if (this.refusing) {
        this.refusing = false;
        response.writeHead(409).end();
        return;
      }
      if (this.failingInput) {
        this.failingInput = false;
        response.writeHead(500).end();
        return;
      }
    }
    response.writeHead(200).end();
  }

  private command(viewer: string, body: unknown): void {
    const command = check(BrowserCommandSchema, body);
    this.commands.push(command);
    if (command.t === "tab") {
      this.activeInputsAtTab = this.activeInputs;
      this.order.push("tab");
    }
    if (command.t === "control") this.control(command.on, viewer);
    else if (command.t === "tab") this.tab = TABS.findIndex((tab) => tab.id === command.id);
    else {
      this.asking = false;
      this.holder = undefined;
    }
    if (command.t !== "control" || this.granting) this.publish();
  }

  private control(on: boolean, viewer: string): void {
    this.requested = on ? viewer : undefined;
    if (on && this.granting) {
      this.holder = viewer;
      this.granted += 1;
    }
    if (!on && this.holder === viewer) this.holder = undefined;
  }

  private async input(body: unknown): Promise<void> {
    assert.ok(typeof body === "object" && body !== null && "events" in body);
    assert.ok(Array.isArray(body.events));
    this.activeInputs += 1;
    for (const raw of body.events) {
      const item: unknown = raw;
      assert.ok(typeof item === "object" && item !== null);
      const entry: Record<string, unknown> = { ...item };
      this.events.push(entry);
      this.order.push(`${String(entry["t"])}:${String(entry["type"])}:${String(entry["key"])}`);
    }
    await this.gate;
    this.activeInputs -= 1;
  }
}
