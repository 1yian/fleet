import type { Board } from "@fleet/protocol";
import type { Page } from "playwright";

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
