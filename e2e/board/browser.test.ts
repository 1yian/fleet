import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { check, BrowserCommandSchema } from "@fleet/protocol";
import { chromium, type Page } from "playwright";
import { boundBoardFile, openBoardPage, startBoardServer } from "../support/board.ts";
import { tempDir } from "../support/run-root.ts";

const BOARD = fileURLToPath(new URL("../../packages/board/dist", import.meta.url));
const TABS = [
  { id: "one", title: "Garden", url: "http://example.test/garden" },
  { id: "two", title: "Workshop", url: "http://example.test/workshop" },
];
const REASON = "Choose a delivery option";

boundBoardFile();

function event(response: ServerResponse, name: string, data: unknown): void {
  response.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
}

class BrowserEndpoint {
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
  commandDelay = 0;
  readonly order: string[] = [];
  readonly events: Record<string, unknown>[] = [];
  readonly commands: unknown[] = [];
  inputDelay = 0;
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
      tabs: TABS,
      control: { kind: this.holder === undefined ? "agent" : "human" },
      credentialStep: false,
      captchaStep: false,
      handoff: this.asking ? { reason: REASON, status: "open" } : null,
      viewLink: "http://retired.invalid:7878/#/browser/garden",
    };
  }

  private state(viewer: string, response: ServerResponse): void {
    const activeTab = TABS[this.tab]?.id;
    event(response, "state", {
      snapshot: this.lane(),
      activeTab,
      viewer: { controlling: this.holder === viewer },
    });
    event(response, "frame", {
      jpeg: this.jpeg[this.tab],
      meta: { targetId: activeTab, deviceWidth: 480, deviceHeight: 300 },
    });
  }

  private publish(): void {
    for (const feed of this.feeds) event(feed, "lane", this.lane());
    for (const [viewer, response] of this.viewers) this.state(viewer, response);
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
      response.once("close", () => this.viewers.delete(viewer));
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
      await new Promise((resolve) => setTimeout(resolve, this.commandDelay));
      this.command(viewer, body);
    } else if (this.holder !== viewer) {
      response.writeHead(409).end("viewer does not hold control, send control first");
      return;
    } else await this.input(body);
    response.writeHead(200).end();
  }

  private command(viewer: string, body: unknown): void {
    const command = check(BrowserCommandSchema, body);
    this.commands.push(command);
    if (command.t === "tab") {
      this.activeInputsAtTab = this.activeInputs;
      this.order.push("tab");
    }
    if (command.t === "control") this.requested = command.on ? viewer : undefined;
    else if (command.t === "tab") this.tab = TABS.findIndex((tab) => tab.id === command.id);
    else {
      this.asking = false;
      this.holder = undefined;
    }
    if (command.t !== "control") this.publish();
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
    await new Promise((resolve) => setTimeout(resolve, this.inputDelay));
    this.activeInputs -= 1;
  }
}

async function renderedJpegs(page: Page): Promise<string[]> {
  const images: string[] = [];
  for (const color of ["forestgreen", "rebeccapurple"]) {
    await page.setContent(`<body style="background:${color}">`);
    images.push((await page.screenshot({ type: "jpeg" })).toString("base64"));
  }
  return images;
}

async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 300 && !condition(); attempt += 1)
    await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(condition());
}

function delivered(endpoint: BrowserEndpoint, match: Record<string, unknown>) {
  return endpoint.events.filter((item) =>
    Object.entries(match).every(([key, value]) => item[key] === value),
  );
}

function near(value: unknown, expected: number): void {
  assert.ok(typeof value === "number" && Math.abs(value - expected) <= 2, String(value));
}

async function nextFrames(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            resolve();
          });
        });
      }),
  );
}

async function screenClick(page: Page): Promise<void> {
  const rect = await page.getByRole("img", { name: "Live browser screen" }).boundingBox();
  assert.ok(rect);
  await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await page.keyboard.press("x");
  await nextFrames(page);
}

async function exerciseInput(page: Page, endpoint: BrowserEndpoint): Promise<void> {
  await until(() => delivered(endpoint, { t: "key", type: "keyUp", key: "x" }).length === 1);
  const [pressed] = delivered(endpoint, { t: "mouse", type: "mousePressed" });
  assert.ok(pressed);
  assert.equal(pressed["button"], "left");
  assert.equal(pressed["clickCount"], 1);
  near(pressed["x"], 240);
  near(pressed["y"], 150);
  const [released] = delivered(endpoint, { t: "mouse", type: "mouseReleased" });
  assert.ok(released);
  near(released["x"], 240);
  near(released["y"], 150);
  assert.equal(delivered(endpoint, { t: "key", type: "keyDown", key: "x", text: "x" }).length, 1);

  endpoint.events.length = 0;
  const rect = await page.getByRole("img", { name: "Live browser screen" }).boundingBox();
  assert.ok(rect);
  await page.waitForTimeout(600);
  await page.mouse.dblclick(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await until(() => delivered(endpoint, { t: "mouse", type: "mouseReleased" }).length === 2);
  assert.deepEqual(
    delivered(endpoint, { t: "mouse", type: "mousePressed" }).map((item) => item["clickCount"]),
    [1, 2],
  );
  assert.deepEqual(
    delivered(endpoint, { t: "mouse", type: "mouseReleased" }).map((item) => item["clickCount"]),
    [1, 2],
  );

  endpoint.events.length = 0;
  await page.keyboard.down("Shift");
  await page.keyboard.press("Escape");
  await page.keyboard.up("Shift");
  await until(() => delivered(endpoint, { t: "key", type: "keyUp", key: "Shift" }).length === 1);
  assert.equal(delivered(endpoint, { t: "key", type: "rawKeyDown", key: "Shift" }).length, 1);
  assert.equal(delivered(endpoint, { t: "key", key: "Escape" }).length, 0);

  endpoint.events.length = 0;
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await page.mouse.down();
  await page.locator(".browser-surface").dispatchEvent("pointercancel");
  await until(() => delivered(endpoint, { t: "mouse", type: "mouseReleased" }).length === 1);
  await page.mouse.up();
  await screenClick(page);
  await until(() => delivered(endpoint, { t: "key", type: "keyUp", key: "x" }).length === 1);
  const presses = delivered(endpoint, { t: "mouse", type: "mousePressed" });
  assert.equal(presses.length, 2);
  assert.equal(presses[1]?.["clickCount"], 1);
  assert.equal(delivered(endpoint, { t: "mouse", type: "mouseReleased" }).length, 2);
}

async function exerciseTabSwitch(page: Page, endpoint: BrowserEndpoint): Promise<void> {
  endpoint.order.length = 0;
  endpoint.inputDelay = 400;
  await screenClick(page);
  await until(() => endpoint.activeInputs > 0);
  await page.keyboard.down("Shift");
  await page.getByRole("button", { name: "Workshop" }).click();
  await page.keyboard.up("Shift");
  await until(() => endpoint.order.includes("tab"));
  assert.equal(endpoint.activeInputsAtTab, 0);
  const release = endpoint.order.indexOf("key:keyUp:Shift");
  assert.ok(release >= 0 && release < endpoint.order.indexOf("tab"));
  endpoint.inputDelay = 0;
}

async function exerciseOutage(page: Page, endpoint: BrowserEndpoint): Promise<void> {
  const commands = endpoint.commands.length;
  const batches = endpoint.events.length;
  endpoint.startOutage();
  await page.getByText("Browser connection interrupted").waitFor();
  await until(() => endpoint.rejected > 0);
  const opens = endpoint.streamOpens;
  endpoint.endOutage();
  await until(() => endpoint.streamOpens > opens);
  await page.mouse.click(300, 250);
  await page.keyboard.press("x");
  await nextFrames(page);
  assert.equal(endpoint.events.length, batches);
  await page.getByText("Browser connection interrupted").waitFor();
  endpoint.releaseState();
  await page.getByText("You’re in control").waitFor();
  assert.equal(endpoint.commands.length, commands);
  assert.equal(endpoint.events.length, batches);
  await screenClick(page);
  await until(() => endpoint.events.length > batches);
}

async function launch(t: TestContext) {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const drawing = await openBoardPage(t, browser, { width: 480, height: 300 });
  const jpeg = await renderedJpegs(drawing);
  const endpoint = new BrowserEndpoint(jpeg);
  await new Promise<void>((resolve) => {
    endpoint.server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => {
    endpoint.server.closeAllConnections();
    endpoint.server.close();
  });
  const address = endpoint.server.address();
  assert.ok(address && typeof address !== "string");
  const token = join(tempDir("browser-token-"), "token");
  writeFileSync(token, endpoint.token, { mode: 0o600 });
  const cardd = await startBoardServer(t, BOARD, {
    CARDD_BROWSER_ORIGIN: `http://127.0.0.1:${String(address.port)}`,
    CARDD_BROWSER_TOKEN_FILE: token,
  });
  const page = await openBoardPage(t, browser);
  const base = cardd.url.replace(/^ws/, "http").replace(/\/session$/, "/");
  return { endpoint, jpeg, page, base };
}

test("the board watches lanes and only drives after stream confirmation, until control is returned or lost", async (t) => {
  const { endpoint, jpeg, page, base } = await launch(t);
  await page.goto(base);
  await page.getByRole("link", { name: "Browsers" }).click();
  await page.getByRole("link", { name: "garden Ready to watch" }).click();
  await page.getByText("Watching · Read only").waitFor();
  await page.getByRole("button", { name: "Workshop" }).click();
  await page.getByText("Take control to switch remote tabs.").waitFor();
  assert.equal(
    await page.getByRole("button", { name: "Garden" }).getAttribute("aria-current"),
    "true",
  );
  const sent: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.endsWith("/input")) sent.push(request.method());
  });
  await screenClick(page);
  assert.deepEqual(sent, []);
  await page.getByRole("link", { name: "‹ Browsers" }).click();
  await page.getByRole("link", { name: "‹ Board" }).click();
  endpoint.ask();
  await page.getByRole("link", { name: `garden needs you ${REASON}` }).click();
  await page.getByText(REASON).waitFor();

  const take = page.waitForResponse((response) =>
    new URL(response.url()).pathname.endsWith("/command"),
  );
  await page.getByRole("button", { name: "Take control" }).click();
  assert.equal((await take).status(), 204);
  await page.getByRole("button", { name: "Taking control…" }).waitFor();
  await screenClick(page);
  assert.deepEqual(sent, []);
  endpoint.confirm();
  await page.getByText("You’re in control").waitFor();
  const input = page.waitForResponse((response) =>
    new URL(response.url()).pathname.endsWith("/input"),
  );
  await screenClick(page);
  assert.equal((await input).status(), 204);
  await exerciseInput(page, endpoint);
  await exerciseTabSwitch(page, endpoint);
  await page.waitForFunction(
    (next) =>
      document.querySelector(".browser-surface img")?.getAttribute("src") ===
      `data:image/jpeg;base64,${next}`,
    jpeg[1],
  );
  assert.equal(
    await page.getByRole("button", { name: "Workshop" }).getAttribute("aria-current"),
    "true",
  );

  await exerciseOutage(page, endpoint);

  await page.getByRole("button", { name: "Done" }).click();
  await page.getByText("Control returned to the agent.").waitFor();
  await page.getByText(REASON).waitFor({ state: "hidden" });
  const retake = page.waitForResponse((response) =>
    new URL(response.url()).pathname.endsWith("/command"),
  );
  await page.getByRole("button", { name: "Take control" }).click();
  assert.equal((await retake).status(), 204);
  endpoint.confirm();
  await page.getByText("You’re in control").waitFor();
  endpoint.revoke();
  await page.getByText("Control ended. You’re watching again.").waitFor();
  const before = sent.length;
  await screenClick(page);
  assert.equal(sent.length, before);
  assert.equal(await page.getByText("viewer does not hold control").count(), 0);
});

test("leaving the board right after Take control does not leave the viewer holding control", async (t) => {
  const { endpoint, page, base } = await launch(t);
  endpoint.commandDelay = 300;
  await page.goto(`${base}#/browser/garden`);
  await page.getByText("Watching · Read only").waitFor();
  const issued = page.waitForRequest((request) =>
    new URL(request.url()).pathname.endsWith("/command"),
  );
  await page.getByRole("button", { name: "Take control" }).click();
  await issued;
  await page.getByRole("link", { name: "‹ Browsers" }).click();
  await until(() => endpoint.commands.length === 2);
  assert.deepEqual(endpoint.commands, [
    { t: "control", on: true },
    { t: "control", on: false },
  ]);
});
