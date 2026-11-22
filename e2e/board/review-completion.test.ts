import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { check, OPS } from "@fleet/protocol";
import { chromium, type Page } from "playwright";
import { boundBoardFile } from "../support/board.ts";
import { Cardd } from "../support/cardd.ts";
import { Harness } from "../support/harness.ts";
import { begin, newCard, status } from "../support/fleet.ts";
import { Lavish } from "../support/lavish.ts";
import { Edge, PUBLIC_HOST, Site } from "../support/public-host.ts";
import { tempDir } from "../support/run-root.ts";

const EXTENSION = fileURLToPath(new URL("../../packages/extension/src/index.ts", import.meta.url));
const BOARD = fileURLToPath(new URL("../../packages/board/dist", import.meta.url));
const HOME = `https://${PUBLIC_HOST}/`;
const WORDS = "LGTM you can make this change";
const ANNOTATION = "Clarify the rollout plan";
boundBoardFile();

async function lavishSite(t: TestContext) {
  const dir = tempDir("fleet-review-completion-");
  const lavish = await Lavish.start(dir);
  const site = await Site.start();
  t.after(async () => {
    await site.issuer.stop();
    await lavish.stop();
  });
  const origin = `http://127.0.0.1:${lavish.env["LAVISH_AXI_PORT"] ?? ""}`;
  const upstream = await Edge.start(new URL(origin));
  upstream.forwardOrigin = true;
  t.after(() => upstream.stop());
  const env = { ...process.env, ...lavish.env };
  const stock = (args: string[]) =>
    execFileSync("lavish-axi", args, { env, encoding: "utf8", timeout: 15000 });
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
  return { site, upstream, stock, open };
}

async function browserOn(t: TestContext, edge: Edge) {
  const mapped = [PUBLIC_HOST, "review.example.test"].map(
    (host) => `MAP ${host} 127.0.0.1:${String(edge.port)}`,
  );
  const browser = await chromium.launch({ args: [`--host-resolver-rules=${mapped.join(", ")}`] });
  t.after(() => browser.close());
  return (await browser.newContext({ ignoreHTTPSErrors: true })).newPage();
}

async function fixture(t: TestContext) {
  const { site, upstream, stock, open } = await lavishSite(t);
  const reportedOrigin = "http://p620.example.test:7331";
  const tools = tempDir("fleet-cardd-tools-");
  const ps = execFileSync("/bin/sh", ["-c", "command -v ps"], { encoding: "utf8" }).trim();
  symlinkSync(ps, join(tools, "ps"));
  const cardd = await Cardd.start(
    {
      ...site.env,
      PATH: tools,
      CARDD_REVIEW_ORIGINS: `${reportedOrigin}=https://127.0.0.1:${String(upstream.port)}`,
      CARDD_REVIEW_ARTIFACT_ORIGIN: "https://review.example.test",
    },
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
  const page = await browserOn(t, edge);
  const h = await Harness.start();
  t.after(() => h.stop());
  const hold = async (title: string, linkOrigin = reportedOrigin) => {
    const { file, session } = open(title);
    const card = await newCard(mate, title, "scout");
    const token = await begin(mate, card);
    const worker = await cardd.connect(token, [], false);
    const link = (source: string) => new URL(new URL(source).pathname, linkOrigin).href;
    const review = link(session);
    const ask = (url = review, key = "draft") =>
      worker.call("report", { status: "needs-decision", key, text: `Ready: ${url}` });
    const question = `Finish ${title}`;
    const shown = async () => {
      const found = (await cardd.board()).holds.find((item) => item.card === card.id);
      assert.ok(found);
      return found;
    };
    const bind = async (url: string | false = review) => {
      const text = url === false ? "Review both the draft and Markdown decision" : question;
      await main.call("hold", { card: card.id, question: text, to: "captain", review: url });
      return (await shown()).hold;
    };
    await ask();
    await mate.call("hold", { card: card.id, question: "Review the draft", review });
    await main.call("hold", { card: card.id, question, to: "captain" });
    const first = await shown();
    const replace = async () => {
      const fresh = link(open(`${title}-replacement`).session);
      await ask(fresh);
      return bind(fresh);
    };
    const path = (id: number) => `/review/${String(card.id)}/${String(id)}`;
    const view = async () => check(OPS.card.result, await mate.call("card", { card: card.id }));
    const answers = async () =>
      (await view()).entries.filter(
        ({ kind, author }) =>
          author === "captain" && (kind === "review-feedback" || kind === "answer"),
      );
    const round = first.hold;
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
  return { mate, main, page, edge, site, stock, hold, base, cardd, h };
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

function submitFleet(page: Page, path: string, words: string, session = ""): Promise<number> {
  return page.evaluate(
    async ({ path, words, session }) => {
      const response = await fetch(path, {
        method: "POST",
        body: new URLSearchParams({ words, session }),
      });
      return response.status;
    },
    { path, words, session },
  );
}

type Lab = Awaited<ReturnType<typeof fixture>>;
type Round = Awaited<ReturnType<Lab["hold"]>>;

const reviewUrl = (round: Round): string => new URL(round.path(round.round), HOME).href;
const statusOf = async (page: Page, url: string): Promise<number | undefined> =>
  (await page.goto(url))?.status();

async function refusals(lab: Lab, target: Round, deferred: Round): Promise<void> {
  const { mate, main, page, edge, site, base, cardd } = lab;
  const plain = await newCard(mate, "Markdown only", "scout");
  const plainWorker = await cardd.connect(await begin(mate, plain));
  await plainWorker.call("report", { status: "needs-decision", key: "md", text: "See report.md" });
  await mate.call("hold", { card: plain.id, question: "Decide" });
  await assert.rejects(
    main.call("hold", { card: plain.id, question: "Decide", to: "captain", review: false }),
    /only for decisions that include a Lavish review/,
  );
  const forged = await fetch(new URL(target.path(target.round), base), {
    method: "POST",
    headers: { authorization: `Bearer ${target.token}` },
    body: new URLSearchParams({ words: WORDS }),
  });
  assert.equal(forged.status, 403);
  edge.token = site.token({ email: "worker@example.test" });
  assert.equal(await statusOf(page, reviewUrl(target)), 403);
  edge.token = site.token();
  assert.equal(await statusOf(page, HOME), 200);
  edge.token = undefined;
  assert.equal(await submitFleet(page, target.path(target.round), WORDS), 403);
  edge.token = site.token();
  assert.equal((await target.view()).hold?.entry, target.round);
  assert.deepEqual(await target.answers(), []);
  const later = { kind: "hold", hold: deferred.round, said: "in 3 hours", zone: "UTC" } as const;
  assert.equal(await cardd.act(deferred.card.id, later), 200);
  const deferredRound = (await deferred.view()).hold?.entry;
  assert.ok(deferredRound);
  assert.notEqual(deferredRound, deferred.round);
  await deferred.worker.call("report", { status: "resolved", key: "draft", text: WORDS });
  assert.equal(await status(mate, deferred.card), "waiting");
  assert.equal((await deferred.view()).hold?.entry, deferredRound);
  assert.equal(await submitFleet(page, deferred.path(deferredRound), WORDS), 409);
  assert.equal(await statusOf(page, new URL(deferred.path(deferredRound), HOME).href), 409);
  assert.deepEqual(await deferred.answers(), []);
}

async function startWorker(lab: Lab, target: Round, direct: Round): Promise<void> {
  const { mate, cardd, h } = lab;
  await target.worker.call("report", { status: "resolved", key: "draft", text: WORDS });
  await submitStock(target.session, false);
  await target.worker.waitForEntry(
    (entry) => entry.kind === "review-feedback" && entry.fields["sessionEnded"] === false,
    "informational feedback from the open source",
  );
  await submitStock(direct.session, true);
  await direct.worker.waitForEntry(
    (entry) => entry.kind === "review-feedback" && entry.fields["sessionEnded"] === true,
    "informational feedback from the ended source",
  );
  assert.equal(await status(mate, target.card), "needs-you");
  assert.equal(await status(mate, direct.card), "needs-you");
  await target.worker.close();
  let reported = false;
  for (let turn = 0; turn < 8; turn += 1)
    h.onModel((turns) => {
      const last = turns.filter((each) => each.role === "user").at(-1)?.text ?? "";
      if (reported || !last.includes("completed the Fleet review")) return { text: "Waiting" };
      reported = true;
      return { tool: "report", args: { status: "done", text: "Plan delivered" } };
    });
  const env = { FLEET_URL: cardd.url, FLEET_TOKEN: target.token, FLEET_ROLE: "worker" };
  h.startPi(`c-${String(target.card.id)}-a1`, env, [EXTENSION]);
  await h.waitFor((event) => event["type"] === "settled", "the worker to settle");
}

async function unmappedLink(lab: Lab, unmapped: Round): Promise<void> {
  const { page } = lab;
  assert.equal(await statusOf(page, HOME), 200);
  const card = page.getByRole("article").filter({ hasText: "Finish Unmapped" });
  await card.getByRole("button", { name: "Your words" }).waitFor();
  assert.equal(await card.getByRole("link", { name: "Open review" }).count(), 0);
  assert.equal(await statusOf(page, reviewUrl(unmapped)), 404);
}

async function openReview(lab: Lab, target: Round) {
  const { page, edge, site } = lab;
  assert.equal(await statusOf(page, HOME), 200);
  const failures: string[] = [];
  page.on("requestfailed", (request) => {
    if (request.url().includes("/review-artifact/"))
      failures.push(request.failure()?.errorText ?? "request failed");
  });
  const question = page.getByRole("article").filter({ hasText: "Finish Plan" });
  await question.getByRole("link", { name: "Open review" }).click();
  assert.equal(page.url(), reviewUrl(target));
  const artifact = page.frameLocator('iframe[title="Review artifact"]');
  const heading = artifact.getByRole("heading", { name: "Plan" });
  await heading.waitFor({ timeout: 5000 }).catch((error: unknown) => {
    throw new Error(failures.join("; "), { cause: error });
  });
  const src = await page.locator('iframe[title="Review artifact"]').getAttribute("src");
  assert.ok(src);
  edge.token = undefined;
  const anonymous = await page.context().newPage();
  assert.equal(await statusOf(anonymous, src), 403);
  await anonymous.close();
  edge.token = site.token();
  return { artifact, heading };
}

async function queueDrafts(
  lab: Lab,
  target: Round,
  opened: Awaited<ReturnType<typeof openReview>>,
) {
  const { mate, page } = lab;
  const { artifact, heading } = opened;
  await page.getByRole("checkbox", { name: "Annotate" }).uncheck();
  const draft = artifact.getByRole("textbox", { name: "Draft note" });
  await draft.fill("Edited without sending");
  assert.equal(await draft.innerText(), "Edited without sending");
  assert.equal((await target.view()).hold?.entry, target.round);
  assert.deepEqual(await target.answers(), []);
  await page.getByRole("checkbox", { name: "Annotate" }).check();
  await heading.click();
  const note = artifact.getByPlaceholder("Tell the agent what to change about this element...");
  const long = "L".repeat(4001);
  for (const words of [long, ANNOTATION]) {
    await note.fill(words);
    await artifact.getByRole("button", { name: "Queue", exact: true }).click();
    await page.getByRole("listitem").filter({ hasText: words }).waitFor();
    if (words === long) await heading.click();
  }
  assert.equal(await page.getByRole("listitem").count(), 2);
  const send = page.getByRole("button", { name: "Send & End" });
  assert.equal(await send.isDisabled(), true);
  await heading.evaluate(() => {
    const sdk: unknown = Reflect.get(window, "lavish");
    if (typeof sdk !== "object" || sdk === null) return;
    for (const name of ["endSession", "sendQueuedPrompts"]) {
      const act: unknown = Reflect.get(sdk, name);
      if (typeof act === "function") Reflect.apply(act, sdk, []);
    }
  });
  await page.getByText("Confirm the queue with Send & End below.").waitFor();
  assert.equal(await status(mate, target.card), "needs-you");
  assert.deepEqual(await target.answers(), []);
  return send;
}

async function completeTarget(
  lab: Lab,
  target: Round,
  send: Awaited<ReturnType<typeof queueDrafts>>,
) {
  const { mate, page, stock, h } = lab;
  await submitStock(target.session, true);
  const reopened = stock([target.file, "--reopen", "--no-open"]);
  assert.match(reopened, new RegExp(new URL(target.session).pathname));
  const board = await page.context().newPage();
  assert.equal(await statusOf(board, HOME), 200);
  const generation = await page.locator('input[name="session"]').inputValue();
  assert.equal(await submitFleet(board, target.path(target.round), WORDS), 409);
  assert.equal((await target.view()).hold?.entry, target.round);
  await page.getByRole("button", { name: "Discard rejected annotation" }).click();
  await page.getByRole("textbox", { name: "Feedback" }).fill(WORDS);
  await send.click();
  await page.waitForURL(HOME);
  const feedback = `${ANNOTATION}\n\n${WORDS}`;
  const receipt = await mate.waitForEntry(
    (entry) => entry.kind === "review-feedback" && entry.author === "captain",
    "the receipt",
  );
  assert.equal(receipt.body, feedback);
  assert.equal(receipt.fields["round"], target.round);
  assert.notEqual(receipt.fields["session"], new URL(target.session).pathname);
  assert.equal((await target.view()).hold, null);
  await mate.waitForEntry(
    (entry) => entry.kind === "report" && entry.fields["status"] === "done",
    "the worker's report after the Fleet review",
  );
  const seen = (h.calls.at(-1) ?? [])
    .filter((turn) => turn.role === "user")
    .map((turn) => turn.text)
    .join("\n");
  assert.match(seen, /stop any poll of the source session/);
  assert.match(
    seen,
    /Lavish feedback on c-\d+ plan \[draft\] \(Lavish session still open; this does not approve or resolve the Fleet hold\):\nOrdinary Lavish feedback/,
  );
  assert.match(seen, /captain completed the Fleet review on c-\d+ plan/);
  assert.ok(seen.includes(feedback));
  assert.match(seen, /Inline annotations \(with targets\): .*"tag":"h1".*"text":"Plan"/);
  return { board, generation, feedback };
}

async function closeTarget(lab: Lab, target: Round): Promise<void> {
  const { mate } = lab;
  const next = { delivered: { evidence: "Plan reviewed", disposition: "No build remains" } };
  await mate.call("close.begin", { card: target.card.id, next });
  const finish = {
    card: target.card.id,
    next,
    mode: "done",
    text: "Closed",
    archives: [],
    left: [],
  };
  await mate.call("close.finish", finish);
  assert.equal(await status(mate, target.card), "done");
  assert.deepEqual(
    (await target.answers()).map(({ kind }) => kind),
    ["review-feedback"],
  );
}

async function replaced(lab: Lab, empty: Round, board: Page): Promise<number> {
  const { page, cardd } = lab;
  const replacement = await empty.replace();
  assert.equal(await statusOf(board, new URL(empty.path(replacement), HOME).href), 200);
  const frame = board.frameLocator('iframe[title="Review artifact"]');
  await frame.getByRole("heading", { name: "No notes-replacement" }).waitFor();
  const retired = await board.locator('iframe[title="Review artifact"]').getAttribute("src");
  assert.ok(retired);
  await empty.update("Markdown decision", "other");
  assert.equal(await statusOf(board, retired), 404);
  assert.equal((await empty.view()).hold?.entry, replacement);
  const answer = {
    kind: "answer",
    hold: replacement,
    choice: "Old answer",
    written: true,
  } as const;
  assert.equal(await cardd.act(empty.card.id, answer), 409);
  const later = { kind: "hold", hold: replacement, said: "in 3 hours", zone: "UTC" } as const;
  assert.equal(await cardd.act(empty.card.id, later), 409);
  assert.equal(await statusOf(page, HOME), 200);
  return replacement;
}

async function staleAndDuplicate(
  lab: Lab,
  rounds: { target: Round; empty: Round; direct: Round },
  done: Awaited<ReturnType<typeof completeTarget>>,
  replacement: number,
): Promise<void> {
  const { page, cardd } = lab;
  const { target, empty, direct } = rounds;
  const mixed = page.getByRole("article").filter({ hasText: "Finish No notes" });
  assert.equal(await mixed.getByRole("button", { name: "Your words" }).count(), 0);
  assert.equal(await mixed.getByRole("button", { name: "Later" }).count(), 0);
  assert.equal(
    await submitFleet(page, target.path(target.round), "Duplicate", done.generation),
    409,
  );
  const rebound = await empty.bind(false);
  assert.notEqual(rebound, replacement);
  const duplicate = {
    kind: "answer",
    hold: target.round,
    choice: "Duplicate",
    written: true,
  } as const;
  assert.equal(await cardd.act(target.card.id, duplicate), 409);
  assert.equal((await empty.view()).hold?.entry, rebound);
  assert.deepEqual(
    (await target.answers()).map(({ body }) => body),
    [done.feedback],
  );
  const reviewed = {
    kind: "answer",
    hold: rebound,
    choice: "Replacement reviewed",
    written: true,
  } as const;
  assert.equal(await cardd.act(empty.card.id, reviewed), 200);
  assert.equal((await direct.view()).hold?.entry, direct.round);
  assert.deepEqual(await direct.answers(), []);
}

async function noteFreeAndFallback(lab: Lab, direct: Round): Promise<void> {
  const { mate, page, hold } = lab;
  const noteFree = await hold("Nothing to add");
  assert.equal(await statusOf(page, reviewUrl(noteFree)), 200);
  await page.getByRole("button", { name: "Send & End" }).click();
  await page.waitForURL(HOME);
  assert.equal((await noteFree.view()).hold, null);
  assert.deepEqual(
    (await noteFree.answers()).map(({ body }) => body),
    [""],
  );
  const fallback = page.getByRole("article").filter({ hasText: "Finish Direct" });
  await fallback.getByRole("button", { name: "Your words" }).click();
  await fallback.getByRole("textbox", { name: "Your words" }).fill("Approved on the board");
  await fallback.getByRole("textbox", { name: "Your words" }).press("Enter");
  await fallback.getByText("Finish Direct").waitFor({ state: "detached" });
  assert.notEqual(await status(mate, direct.card), "needs-you");
}

test("Fleet completes owned stock Lavish rounds without trusting worker sessions", async (t) => {
  const lab = await fixture(t);
  const target = await lab.hold("Plan");
  const direct = await lab.hold("Direct");
  const empty = await lab.hold("No notes");
  const deferred = await lab.hold("Later");
  const unmapped = await lab.hold("Unmapped", "http://unconfigured.example.test:7331");
  await refusals(lab, target, deferred);
  await startWorker(lab, target, direct);
  await unmappedLink(lab, unmapped);
  const opened = await openReview(lab, target);
  const send = await queueDrafts(lab, target, opened);
  const done = await completeTarget(lab, target, send);
  await closeTarget(lab, target);
  const replacement = await replaced(lab, empty, done.board);
  await staleAndDuplicate(lab, { target, empty, direct }, done, replacement);
  await noteFreeAndFallback(lab, direct);
});
