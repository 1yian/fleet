import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { readFileSync } from "node:fs";
import { BrowserLab, browse, recordsOf, results } from "../support/browser-lab.ts";

let lab: BrowserLab;
beforeEach(async () => {
  lab = await BrowserLab.start();
});
afterEach(async () => {
  await lab.stop();
});

test("a worker drives its own tab with browser-axi, and its screenshot is saved as a picture file", async () => {
  const first = await lab.crew("Users see one scrollbar");
  const second = await lab.crew("Users see one footer");
  const { site } = lab;
  browse(first.h, { action: "open", url: site.url("/a") });
  browse(first.h, { action: "click", selector: "#count" });
  browse(first.h, { action: "type", selector: "#q", text: "hello" });
  browse(first.h, { action: "eval", expression: "document.getElementById('q').value" });
  browse(first.h, { action: "read", selector: "#n" });
  browse(first.h, { action: "screenshot" });
  first.h.onModel(() => ({ tool: "report", args: { status: "done", text: "looked" } }));
  browse(second.h, { action: "open", url: site.url("/b") });
  browse(second.h, { action: "read" });
  second.h.onModel(() => ({ tool: "report", args: { status: "done", text: "looked" } }));

  const mine = results(await first.h.waitForCall(6));
  const theirs = results(await second.h.waitForCall(2));

  assert.match(
    mine[0] ?? "",
    /^Opened "c-\d+ users-see-one-scrollbar - Alpha" at http:\/\/127\.0\.0\.1:\d+\/a in your tab c-\d+ users-see-one-scrollbar\.$/,
  );
  assert.equal(mine[1], "Clicked #count.");
  assert.equal(mine[2], "Typed 5 characters.");
  assert.equal(mine[3], '"hello"');
  assert.equal(mine[4], "1");
  assert.match(mine[5] ?? "", /^Screenshot of "c-\d+ users-see-one-scrollbar - Alpha"/);
  const picture = recordsOf(await first.h.waitForCall(6)).at(-1)?.["image"];
  assert.equal(typeof picture, "string");
  assert.equal(readFileSync(String(picture)).subarray(1, 4).toString(), "PNG");
  assert.equal(theirs[1], "bravo page");
  assert.equal((await lab.chrome.pages()).length, 2);
});
