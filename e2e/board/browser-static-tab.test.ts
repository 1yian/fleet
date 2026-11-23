import assert from "node:assert/strict";
import { test } from "node:test";
import { boundBoardFile } from "../support/board.ts";
import { launch, takeControl, clickAndSettle } from "../support/browser-lab.ts";

boundBoardFile();

test("a late frame for the old tab on a static tab regains input through one fresh screencast", async (t) => {
  const { endpoint, jpeg, page, base } = await launch(t);
  await takeControl(page, endpoint, base);
  await clickAndSettle(page, endpoint);
  await page.getByRole("button", { name: "Workshop" }).click();
  await page
    .locator(`.browser-surface.driving img[src="data:image/jpeg;base64,${jpeg[1] ?? ""}"]`)
    .waitFor();
  const before = endpoint.commands.length;
  endpoint.showFrame(0);
  await page.getByText("Waiting for the browser screen…").waitFor();
  await page
    .locator(`.browser-surface.driving img[src="data:image/jpeg;base64,${jpeg[1] ?? ""}"]`)
    .waitFor();
  assert.deepEqual(endpoint.commands.slice(before), [{ t: "tab", action: "activate", id: "two" }]);
});
