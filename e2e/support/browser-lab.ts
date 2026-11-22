import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright";
import { BrowserEndpoint } from "./browser-endpoint.ts";
import { openBoardPage, startBoardServer } from "./board.ts";
import { tempDir } from "./run-root.ts";

const BOARD = fileURLToPath(new URL("../../packages/board/dist", import.meta.url));

async function renderedJpegs(page: Page): Promise<string[]> {
  const images: string[] = [];
  for (const color of ["forestgreen", "rebeccapurple"]) {
    await page.setContent(`<body style="background:${color}">`);
    images.push((await page.screenshot({ type: "jpeg" })).toString("base64"));
  }
  return images;
}

export async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 300 && !condition(); attempt += 1)
    await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(condition());
}

export function delivered(endpoint: BrowserEndpoint, match: Record<string, unknown>) {
  return endpoint.events.filter((item) =>
    Object.entries(match).every(([key, value]) => item[key] === value),
  );
}

export function near(value: unknown, expected: number): void {
  assert.ok(typeof value === "number" && Math.abs(value - expected) <= 2, String(value));
}

export async function nextFrames(page: Page): Promise<void> {
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

export async function screenClick(page: Page): Promise<void> {
  const rect = await page.getByRole("img", { name: "Live browser screen" }).boundingBox();
  assert.ok(rect);
  await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await page.keyboard.press("x");
  await nextFrames(page);
}

export async function takeControl(
  page: Page,
  endpoint: BrowserEndpoint,
  base: string,
): Promise<void> {
  await page.goto(`${base}#/browser/garden`);
  await page.getByText("Watching · Read only").waitFor();
  await page.getByRole("button", { name: "Take control" }).click();
  await until(() => endpoint.commands.length === 1);
  endpoint.confirm();
  await page.getByText("You’re in control").waitFor();
}

export async function launch(t: TestContext) {
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
