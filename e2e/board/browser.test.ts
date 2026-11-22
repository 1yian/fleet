import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
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
    if (url.pathname === "/v1/events") {
      this.begin(response);
      this.feeds.add(response);
      response.once("close", () => this.feeds.delete(response));
      event(response, "lane", this.lane());
    } else if (url.pathname.endsWith("/stream")) {
      this.begin(response);
      this.viewers.set(viewer, response);
      response.once("close", () => this.viewers.delete(viewer));
      this.state(viewer, response);
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
      const command = check(BrowserCommandSchema, body);
      if (command.t === "control") this.requested = command.on ? viewer : undefined;
      else if (command.t === "tab") this.tab = TABS.findIndex((tab) => tab.id === command.id);
      else {
        this.asking = false;
        this.holder = undefined;
      }
      if (command.t !== "control") this.publish();
    } else if (this.holder !== viewer) {
      response.writeHead(409).end("viewer does not hold control, send control first");
      return;
    }
    response.writeHead(200).end();
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

async function screenClick(page: Page): Promise<void> {
  const rect = await page.getByRole("img", { name: "Live browser screen" }).boundingBox();
  assert.ok(rect);
  await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await page.keyboard.press("x");
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => {
          requestAnimationFrame(() => resolve());
        }),
      ),
  );
}

test("the board watches lanes and only drives after stream confirmation, until control is returned or lost", async (t) => {
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
  await page.goto(cardd.url.replace(/^ws/, "http").replace(/\/session$/, "/"));
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
  assert.ok(sent.length > 0);
  await page.getByRole("button", { name: "Workshop" }).click();
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
