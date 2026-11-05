import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { recordOf, runAxi, type AxiRun } from "../support/browser-axi.ts";
import { BrowserLab, browse, recordsOf, results, type RawWorker } from "../support/browser-lab.ts";
import { tempDir } from "../support/run-root.ts";

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

const axi = (worker: RawWorker, ...args: string[]): Promise<AxiRun> =>
  runAxi([...args, "--json"], worker.access);

const helpOf = (run: AxiRun): string[] => {
  const help = recordOf(run)["help"];
  assert.ok(Array.isArray(help));
  return help.map(String);
};

test("an action with no tab says to run browser-axi open, and its error has a help line", async () => {
  const worker = await lab.worker("Look at the page");

  const read = await axi(worker, "read");

  assert.equal(read.code, 1, read.stdout);
  const error = String(recordOf(read)["error"]);
  assert.match(error, /^you have no tab yet: run `browser-axi open <url>` first$/);
  assert.doesNotMatch(error, /call browser/);
  assert.deepEqual(helpOf(read), [
    "Run `browser-axi open <url>` to load a page in your tab",
    "Run `browser-axi --help` for every command",
  ]);
});

test("click with no selector and no point is a usage error with a help line", async () => {
  const worker = await lab.worker("Look at the page");
  await worker.act({ action: "open", url: lab.site.url("/a") });

  for (const args of [["click"], ["click", "--x", "5"]]) {
    const click = await axi(worker, ...args);
    assert.equal(click.code, 2, click.stdout);
    assert.match(
      String(recordOf(click)["error"]),
      /^click wants --selector <css>, or --x <n> --y <n>/,
    );
    assert.deepEqual(helpOf(click), ["Run `browser-axi --help` for every command"]);
  }
  assert.equal(await worker.act({ action: "read", selector: "#n" }), "0");
});

test("the status help offers read, screenshot and close once a tab is open", async () => {
  const worker = await lab.worker("Look at the page");

  const before = await axi(worker);
  assert.deepEqual(helpOf(before), [
    "Run `browser-axi open <url>` to open your tab",
    "Run `browser-axi --help` for every command",
  ]);

  await worker.act({ action: "open", url: lab.site.url("/a") });
  const during = await axi(worker);
  assert.equal(during.code, 0, during.stdout);
  assert.deepEqual(recordOf(during)["tabs"], [`c-${String(worker.card.id)} look-at-the-page`]);
  assert.deepEqual(helpOf(during), [
    "Run `browser-axi read` for the page's text, `browser-axi screenshot` for a picture, or `browser-axi close` when you are done with your tab",
    "Run `browser-axi --help` for every command",
  ]);

  await worker.act({ action: "close" });
  assert.match(
    helpOf(await axi(worker))[0] ?? "",
    /^Run `browser-axi open <url>` to open your tab$/,
  );
});

test("login on a host with no logins says so plainly, names the host, and tells the worker to ask its mate", async () => {
  const worker = await lab.worker("Sign in to the portal");
  await worker.act({ action: "open", url: lab.site.url("/login") });

  const login = await axi(worker, "login");

  assert.equal(login.code, 1, login.stdout);
  const error = String(recordOf(login)["error"]);
  assert.equal(
    error,
    "logins are not set up on maverick. Ask your mate to set them up for this host",
  );
  assert.doesNotMatch(error, /--browser|Bitwarden|docs\/setup/);
  assert.deepEqual(helpOf(login), [
    "Tell your mate that logins are not set up on this host, and report paused or blocked until they are",
    "Never ask for, type, store, or report a password, a code, or a token",
  ]);
});

test("click and read say the page's title and address, so a worker sees whether a click navigated", async () => {
  const worker = await lab.worker("Follow the link");
  const start = lab.site.url("/links");
  await worker.act({ action: "open", url: start });
  const label = `c-${String(worker.card.id)} follow-the-link`;

  const stay = recordOf(await axi(worker, "click", "--selector", "#stay"));
  assert.equal(stay["page"], `"${label} - Links" at ${start}`);

  const moved = recordOf(await axi(worker, "click", "--selector", "#next"));
  assert.equal(moved["result"], "Clicked #next.");
  assert.equal(moved["page"], `"${label} - Bravo" at ${lab.site.url("/b")}`);

  const read = recordOf(await axi(worker, "read"));
  assert.equal(read["result"], "bravo page");
  assert.equal(read["page"], `"${label} - Bravo" at ${lab.site.url("/b")}`);
});

test("a click that only changes the address within the page returns at once, with the new address", async () => {
  const worker = await lab.worker("Follow the link");
  const start = lab.site.url("/links");
  await worker.act({ action: "open", url: start });
  const label = `c-${String(worker.card.id)} follow-the-link - Links`;

  const fragment = recordOf(await axi(worker, "click", "--selector", "#fragment"));
  assert.equal(fragment["result"], "Clicked #fragment.");
  assert.equal(fragment["page"], `"${label}" at ${start}#section`);

  const pushed = recordOf(await axi(worker, "click", "--selector", "#push"));
  assert.equal(pushed["result"], "Clicked #push.");
  assert.equal(pushed["page"], `"${label}" at ${lab.site.url("/pushed")}`);
});

test("eval prints a string and an object once, not as JSON inside JSON", async () => {
  const worker = await lab.worker("Look at the page");
  await worker.act({ action: "open", url: lab.site.url("/a") });

  const title = recordOf(await axi(worker, "eval", "document.title"));
  assert.equal(title["result"], `c-${String(worker.card.id)} look-at-the-page - Alpha`);

  const object = recordOf(await axi(worker, "eval", "({ a: 1, b: [2, 'x'], c: null })"));
  assert.deepEqual(object["result"], { a: 1, b: [2, "x"], c: null });

  const plain = await runAxi(["eval", "--", "'hello'"], worker.access);
  assert.equal(plain.code, 0, plain.stdout);
  assert.match(plain.stdout, /^action: eval\nresult: hello\n/);
});

test("a default screenshot clears the old picture folders that nothing else removes, and only those", async () => {
  const worker = await lab.worker("Look at the page");
  await worker.act({ action: "open", url: lab.site.url("/a") });
  const temp = tempDir("fleet-shot-sweep-");
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  const made = (name: string, old: boolean): void => {
    const folder = join(temp, name);
    mkdirSync(folder);
    writeFileSync(join(folder, "screenshot.png"), "picture");
    if (old) utimesSync(folder, twoDaysAgo, twoDaysAgo);
  };
  made("fleet-shot-old1", true);
  made("fleet-shot-old2", true);
  made("fleet-shot-recent", false);
  made("kept-by-another-tool", true);

  const shot = await runAxi(["screenshot", "--json"], worker.access, { TMPDIR: temp });

  assert.equal(shot.code, 0, shot.stdout);
  const file = String(recordOf(shot)["image"]);
  assert.equal(readFileSync(file).subarray(1, 4).toString(), "PNG");
  const left = readdirSync(temp).sort();
  assert.equal(left.length, 3);
  assert.deepEqual(
    left.filter((name) => !file.startsWith(join(temp, name))),
    ["fleet-shot-recent", "kept-by-another-tool"],
  );
});
