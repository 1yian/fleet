import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { check, OPS } from "@fleet/protocol";
import { chromium, type Page } from "playwright";
import { boundBoardFile } from "../support/board.ts";
import { Cardd } from "../support/cardd.ts";
import { begin, newCard, status } from "../support/fleet.ts";
import { Lavish } from "../support/lavish.ts";
import { Edge, PUBLIC_HOST, Site } from "../support/public-host.ts";
import { tempDir } from "../support/run-root.ts";

const BOARD = fileURLToPath(new URL("../../packages/board/dist", import.meta.url));
const HOME = `https://${PUBLIC_HOST}/`;
const WORDS = "LGTM you can make this change";
const ANNOTATION = "Clarify the rollout plan";
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
  const reportedOrigin = "http://p620.example.test:7331";
  const cardd = await Cardd.start(
    { ...site.env, CARDD_REVIEW_ORIGINS: `${reportedOrigin}=${origin}` },
    [...site.flags, "--board", BOARD],
  );
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
    writeFileSync(
      file,
      `<!doctype html><body style="background:white"><h1>${title}</h1><p contenteditable aria-label="Draft note" role="textbox">Original</p></body>`,
    );
    const opened = stock([file, "--no-open"]);
    const session = /https?:\/\/[^\s"']+\/session\/[a-f0-9]+/.exec(opened)?.[0];
    assert.ok(session);
    return { file, session };
  };
  const hold = async (title: string, linkOrigin = reportedOrigin) => {
    const { file, session } = open(title);
    const card = await newCard(mate, title, "scout");
    const token = await begin(mate, card);
    const worker = await cardd.connect(token);
    const link = (source: string) => new URL(new URL(source).pathname, linkOrigin).href;
    const review = link(session);
    const ask = (url = review) =>
      worker.call("report", { status: "needs-decision", key: "draft", text: `Ready: ${url}` });
    const question = `Finish ${title}`;
    const bind = async (url = review) => {
      await main.call("hold", { card: card.id, question, to: "captain", review: url });
      const shown = (await cardd.board()).holds.find((item) => item.card === card.id);
      assert.ok(shown);
      return shown.hold;
    };
    const escalate = () => mate.call("hold", { card: card.id, question: "Review the draft" });
    await ask();
    await escalate();
    const round = await bind();
    const replace = async () => {
      const fresh = link(open(`${title}-replacement`).session);
      await ask(fresh);
      await escalate();
      return bind(fresh);
    };
    const path = (id: number) => `/review/${String(card.id)}/${String(id)}`;
    const view = async () => check(OPS.card.result, await mate.call("card", { card: card.id }));
    const answers = async () =>
      (await view()).entries.filter(({ kind }) => kind === "review-feedback" || kind === "answer");
    return {
      card,
      token,
      worker,
      file,
      session,
      round,
      path,
      view,
      answers,
      update: ask,
      bind,
      replace,
    };
  };
  return { mate, page, edge, site, stock, hold, base, cardd };
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

function submitFleet(page: Page, path: string, words: string): Promise<number> {
  return page.evaluate(
    async ({ path, words }) => {
      const response = await fetch(path, { method: "POST", body: new URLSearchParams({ words }) });
      return response.status;
    },
    { path, words },
  );
}

test("stock Lavish preview preserves drafts without completing a reopenable review", async (t) => {
  const { mate, page, edge, site, stock, hold, base, cardd } = await fixture(t);
  const target = await hold("Plan");
  const direct = await hold("Direct");
  const deferred = await hold("Later");
  const unmapped = await hold("Unmapped", "http://unconfigured.example.test:7331");
  const reviewUrl = new URL(target.path(target.round), HOME).href;
  const forged = await fetch(new URL(target.path(target.round), base), {
    method: "POST",
    headers: { authorization: `Bearer ${target.token}` },
    body: new URLSearchParams({ words: WORDS }),
  });
  assert.equal(forged.status, 403);
  edge.token = site.token({ email: "worker@example.test" });
  assert.equal((await page.goto(reviewUrl))?.status(), 403);
  edge.token = site.token();
  assert.equal((await page.goto(HOME))?.status(), 200);
  edge.token = undefined;
  assert.equal(await submitFleet(page, target.path(target.round), WORDS), 403);
  edge.token = site.token();
  assert.equal((await target.view()).hold?.entry, target.round);
  assert.deepEqual(await target.answers(), []);
  assert.equal(
    await cardd.act(deferred.card.id, {
      kind: "hold",
      hold: deferred.round,
      said: "in 3 hours",
      zone: "UTC",
    }),
    200,
  );
  const deferredRound = (await deferred.view()).hold?.entry;
  assert.ok(deferredRound);
  assert.notEqual(deferredRound, deferred.round);
  await deferred.worker.call("report", { status: "resolved", key: "draft", text: WORDS });
  assert.equal(await status(mate, deferred.card), "waiting");
  assert.equal((await deferred.view()).hold?.entry, deferredRound);
  assert.equal(await submitFleet(page, deferred.path(deferredRound), WORDS), 409);
  assert.equal((await page.goto(new URL(deferred.path(deferredRound), HOME).href))?.status(), 409);
  assert.deepEqual(await deferred.answers(), []);
  await target.worker.call("report", { status: "resolved", key: "draft", text: WORDS });
  await submitStock(target.session, false);
  await submitStock(direct.session, true);
  assert.equal(await status(mate, target.card), "needs-you");
  assert.equal(await status(mate, direct.card), "needs-you");
  assert.equal((await page.goto(HOME))?.status(), 200);
  const question = page.getByRole("article").filter({ hasText: "Finish Plan" });
  const unmappedQuestion = page.getByRole("article").filter({ hasText: "Finish Unmapped" });
  await unmappedQuestion.getByRole("button", { name: "Your words" }).waitFor();
  assert.equal(await unmappedQuestion.getByRole("link", { name: "Preview review" }).count(), 0);
  assert.equal((await page.goto(new URL(unmapped.path(unmapped.round), HOME).href))?.status(), 404);
  assert.equal((await page.goto(HOME))?.status(), 200);
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
  await question.getByRole("link", { name: "Preview review" }).click();
  assert.equal(page.url(), reviewUrl);
  const artifact = page.frameLocator('iframe[title="Review artifact"]');
  const heading = artifact.getByRole("heading", { name: "Plan" });
  await heading.waitFor({ timeout: 5000 }).catch((error: unknown) => {
    throw new Error(frameRequests.join("; "), { cause: error });
  });
  await page.getByRole("checkbox", { name: "Annotate" }).uncheck();
  const draft = artifact.getByRole("textbox", { name: "Draft note" });
  await draft.fill("Edited without sending");
  assert.equal(await draft.innerText(), "Edited without sending");
  assert.equal((await target.view()).hold?.entry, target.round);
  assert.deepEqual(await target.answers(), []);
  await page.getByRole("checkbox", { name: "Annotate" }).check();
  await heading.click();
  const annotation = artifact.getByPlaceholder(
    "Tell the agent what to change about this element...",
  );
  const long = "L".repeat(4001);
  for (const words of [long, ANNOTATION]) {
    await annotation.fill(words);
    await artifact.getByRole("button", { name: "Queue", exact: true }).click();
    await page
      .getByRole("listitem")
      .filter({ hasText: `Plan: ${words}` })
      .waitFor();
    if (words === long) await heading.click();
  }
  assert.equal(await page.getByRole("listitem").count(), 2);
  assert.equal(await page.getByRole("button", { name: "Send & End" }).count(), 0);
  await heading.evaluate(() => {
    const sdk = Reflect.get(window, "lavish") as {
      endSession: () => void;
      sendQueuedPrompts: () => void;
    };
    sdk.endSession();
    sdk.sendQueuedPrompts();
  });
  await page.getByText("This preview cannot send or end the review.").waitFor();
  assert.equal(await status(mate, target.card), "needs-you");
  assert.deepEqual(await target.answers(), []);
  await submitStock(target.session, true);
  assert.match(
    stock([target.file, "--reopen", "--no-open"]),
    new RegExp(new URL(target.session).pathname),
  );
  const board = await page.context().newPage();
  assert.equal((await board.goto(HOME))?.status(), 200);
  for (const words of [WORDS, ""]) {
    assert.equal(await submitFleet(board, target.path(target.round), words), 409);
    assert.equal((await target.view()).hold?.entry, target.round);
    assert.deepEqual(await target.answers(), []);
  }
  await submitStock(target.session, false);
  await target.update();
  await assert.rejects(target.bind(), /a new review needs a fresh Lavish session link/);
  assert.equal((await target.view()).hold?.entry, target.round);
  assert.equal(
    await cardd.act(target.card.id, {
      kind: "answer",
      hold: target.round,
      choice: "Old answer",
      written: true,
    }),
    409,
  );
  assert.equal(
    await cardd.act(target.card.id, {
      kind: "hold",
      hold: target.round,
      said: "in 3 hours",
      zone: "UTC",
    }),
    409,
  );
  assert.equal((await page.goto(reviewUrl))?.status(), 409);
  assert.equal((await page.goto(HOME))?.status(), 200);
  await question.getByRole("button", { name: "Your words" }).waitFor();
  assert.equal(await question.getByRole("link", { name: "Preview review" }).count(), 0);
  await question.getByRole("button", { name: "Your words" }).click();
  await question.getByRole("textbox", { name: "Your words" }).fill(WORDS);
  await question.getByRole("textbox", { name: "Your words" }).press("Enter");
  await question.getByText("Finish Plan").waitFor({ state: "detached" });
  assert.deepEqual(
    (await target.answers()).map(({ body }) => body),
    [WORDS],
  );
  const replacement = await target.replace();
  assert.notEqual(replacement, target.round);
  assert.equal(await submitFleet(page, target.path(target.round), "Duplicate"), 409);
  assert.equal(
    await cardd.act(target.card.id, {
      kind: "answer",
      hold: target.round,
      choice: "Duplicate",
      written: true,
    }),
    409,
  );
  assert.equal((await target.view()).hold?.entry, replacement);
  assert.deepEqual(
    (await target.answers()).map(({ body }) => body),
    [WORDS],
  );
  assert.equal(
    await cardd.act(target.card.id, {
      kind: "answer",
      hold: replacement,
      choice: "Replacement reviewed",
      written: true,
    }),
    200,
  );
  assert.equal((await direct.view()).hold?.entry, direct.round);
  assert.deepEqual(await direct.answers(), []);
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
