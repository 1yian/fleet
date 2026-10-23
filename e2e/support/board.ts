import assert from "node:assert/strict";
import type { Board } from "@fleet/protocol";
import type { SuiteContext, TestContext } from "node:test";
import type { Browser, Page } from "playwright";
import { Cardd } from "./cardd.ts";

export async function freezeBoardUntilAction(page: Page, snapshot: Board): Promise<void> {
  let frozen = true;
  await page.route("**/api/board", (route) =>
    frozen ? route.fulfill({ json: snapshot }) : route.continue(),
  );
  await page.route("**/api/action", (route) => {
    frozen = false;
    return route.continue();
  });
}

const FILE_LIFETIME_MS = 10 * 60_000;

export function boundBoardFile(): void {
  setTimeout(() => {
    console.error(
      `Board test file exceeded ${String(FILE_LIFETIME_MS / 1000)}s, including teardown`,
    );
    process.exit(1);
  }, FILE_LIFETIME_MS).unref();
}

export async function startBoardServer(
  context: TestContext | SuiteContext,
  board: string,
  env: Record<string, string> = {},
): Promise<Cardd> {
  const server = await Cardd.start(env, ["--board", board]);
  assert.ok("after" in context);
  context.after(() => server.stop());
  return server;
}

export async function openBoardPage(
  context: TestContext | SuiteContext,
  browser: Browser,
  viewport?: { width: number; height: number },
): Promise<Page> {
  const page = await browser.newPage(viewport === undefined ? {} : { viewport });
  assert.ok("after" in context);
  context.after(() => page.close());
  return page;
}
