import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { boundBoardFile } from "../support/board.ts";
import { Cardd } from "../support/cardd.ts";
import { begin, newCard, status } from "../support/fleet.ts";
import { Lavish } from "../support/lavish.ts";
import { Edge, PUBLIC_HOST, Site } from "../support/public-host.ts";
import { tempDir } from "../support/run-root.ts";

const BOARD = fileURLToPath(new URL("../../packages/board/dist", import.meta.url));
const HOME = `https://${PUBLIC_HOST}/`;
const WORDS = "LGTM you can make this change";
boundBoardFile();

async function fixture(t: TestContext) {
  const dir = tempDir("fleet-review-completion-");
  const lavish = await Lavish.start(dir);
  const site = await Site.start();
  t.after(async () => {
    await site.issuer.stop();
    await lavish.stop();
  });
  const origin = `http://127.0.0.1:${lavish.env["LAVISH_AXI_PORT"] ?? ""}`;
  const cardd = await Cardd.start({ ...site.env, CARDD_REVIEW_ORIGINS: origin }, [
    ...site.flags,
    "--board",
    BOARD,
  ]);
  t.after(() => cardd.stop());
  const main = await cardd.connect(cardd.addLane("main"));
  const mate = await cardd.connect(cardd.addLane("cleo", "main"));
  cardd.addProject("web", { maverick: "/clones/web" }, "acme/web");
  const base = cardd.url.replace(/^ws/, "http");
  const edge = await Edge.start(new URL(base));
  t.after(() => edge.stop());
  edge.token = site.token();
  const browser = await chromium.launch({
    args: [`--host-resolver-rules=MAP ${PUBLIC_HOST} 127.0.0.1:${String(edge.port)}`],
  });
  t.after(() => browser.close());
  const page = await (await browser.newContext({ ignoreHTTPSErrors: true })).newPage();
  const localEnv = { ...process.env, ...lavish.env };
  const stock = (args: string[]) =>
    execFileSync("lavish-axi", args, { env: localEnv, encoding: "utf8", timeout: 15000 });
  const open = (title: string) => {
    const file = join(dir, `${title}.html`);
    writeFileSync(file, `<!doctype html><body style="background:white"><h1>${title}</h1></body>`);
    const opened = stock([file, "--no-open"]);
    const session = /https?:\/\/[^\s"']+\/session\/[a-f0-9]+/.exec(opened)?.[0];
    assert.ok(session);
    return { file, session };
  };
  const hold = async (title: string) => {
    const { file, session } = open(title);
    const card = await newCard(mate, title, "scout");
    const token = await begin(mate, card);
    const worker = await cardd.connect(token);
    const ask = (key: string) =>
      worker.call("report", { status: "needs-decision", key, text: `Ready: ${session}` });
    const bind = async (question: string) => {
      await main.call("hold", { card: card.id, question, to: "captain", review: session });
      const round = (await cardd.board()).holds.find((item) => item.card === card.id)?.hold;
      assert.ok(round);
      return `/review/${String(card.id)}/${String(round)}`;
    };
    await ask("draft");
    await mate.call("hold", { card: card.id, question: "Review the draft" });
    const stale = await bind("Review the draft");
    await ask("revision");
    const path = await bind(`Finish ${title}`);
    return { card, token, worker, file, session, stale, path };
  };
  return { mate, page, edge, site, stock, hold, base };
}

async function submitStock(session: string, endSession: boolean): Promise<void> {
  const origin = new URL(session).origin;
  const key = new URL(session).pathname.split("/").at(-1) ?? "";
  const response = await fetch(`${origin}/api/${key}/prompts`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({
      prompts: [{ tag: "message", prompt: "Ordinary Lavish feedback" }],
      endSession,
    }),
  });
  assert.equal(response.status, 200, await response.text());
}

test("the Fleet reviewer sends and ends stock Lavish from the board, clearing only the bound round", async (t) => {
  const { mate, page, edge, site, stock, hold, base } = await fixture(t);
  const target = await hold("Plan");
  const direct = await hold("Direct");
  const reviewUrl = new URL(target.path, HOME).href;
  const forged = await fetch(new URL(target.path, base), {
    method: "POST",
    headers: { authorization: `Bearer ${target.token}` },
    body: new URLSearchParams({ words: WORDS }),
  });
  assert.equal(forged.status, 403);
  edge.token = site.token({ email: "worker@example.test" });
  assert.equal((await page.goto(reviewUrl))?.status(), 403);
  edge.token = site.token();
  assert.equal((await page.goto(new URL(target.stale, HOME).href))?.status(), 409);
  await target.worker.call("report", { status: "resolved", key: "draft", text: WORDS });
  await target.worker.call("report", { status: "resolved", key: "revision", text: WORDS });
  await submitStock(target.session, false);
  await submitStock(direct.session, true);
  assert.equal(await status(mate, target.card), "needs-you");
  assert.equal(await status(mate, direct.card), "needs-you");
  assert.equal((await page.goto(HOME))?.status(), 200);
  const question = page.getByRole("article").filter({ hasText: "Finish Plan" });
  const frameRequests: string[] = [];
  page.on("response", (response) => {
    if (response.url().includes("/artifact/"))
      frameRequests.push(`HTTP ${String(response.status())}`);
  });
  page.on("requestfailed", (request) => {
    if (request.url().includes("/artifact/"))
      frameRequests.push(request.failure()?.errorText ?? "request failed");
  });
  page.on("console", (message) => {
    if (message.type() === "error")
      frameRequests.push(message.text().replace(/\?[^'" ]+/g, "?[redacted]"));
  });
  await question.getByRole("link", { name: "Open review" }).click();
  assert.equal(page.url(), reviewUrl);
  await page
    .frameLocator('iframe[title="Review artifact"]')
    .getByRole("heading", { name: "Plan" })
    .waitFor({ timeout: 5000 })
    .catch((error: unknown) => {
      throw new Error(frameRequests.join("; "), { cause: error });
    });
  await page.getByRole("textbox", { name: "Feedback" }).fill(WORDS);
  assert.equal(await status(mate, target.card), "needs-you");
  await page.getByRole("button", { name: "Send & End" }).click();
  await page.waitForURL(HOME);
  assert.equal(await status(mate, target.card), "working");
  assert.equal(await status(mate, direct.card), "needs-you");
  const record = await mate.waitForEntry(
    (entry) => entry.kind === "review-feedback",
    "the review answer",
  );
  assert.equal(record.author, "captain");
  assert.equal(record.body, WORDS);
  assert.deepEqual(record.fields["keys"], ["draft", "revision"]);
  const poll = stock(["poll", target.file, "--owner", "fleet-test"]);
  assert.match(poll, /session_ended: true/);
  assert.ok(poll.includes(WORDS));
  const retry = await page.evaluate(
    async ({ path, words }) => {
      const result = await fetch(path, { method: "POST", body: new URLSearchParams({ words }) });
      return result.status;
    },
    { path: target.path, words: WORDS },
  );
  assert.equal(retry, 200);
  await target.worker.call("report", { status: "done", text: "Plan delivered" });
  const next = { delivered: { evidence: "Plan reviewed", disposition: "No build remains" } };
  await mate.call("close.begin", { card: target.card.id, next });
  await mate.call("close.finish", {
    card: target.card.id,
    next,
    mode: "done",
    text: "Closed",
    archives: [],
    left: [],
  });
  assert.equal(await status(mate, target.card), "done");
  const fallback = page.getByRole("article").filter({ hasText: "Finish Direct" });
  await fallback.getByRole("button", { name: "Your words" }).click();
  await fallback.getByRole("textbox", { name: "Your words" }).fill("Approved on the board");
  await fallback.getByRole("textbox", { name: "Your words" }).press("Enter");
  await fallback.getByText("Finish Direct").waitFor({ state: "detached" });
  assert.notEqual(await status(mate, direct.card), "needs-you");
});
