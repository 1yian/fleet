import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { check, OPS, type Card } from "@fleet/protocol";
import { Cardd } from "../support/cardd.ts";
import { begin, newCard, status, type Fleet } from "../support/fleet.ts";
import { gate, Harness, type Turn } from "../support/harness.ts";
import { HerdrLab } from "../support/herdr.ts";
import { isRecord, parseRecord, records } from "../support/json.ts";
import { Lavish } from "../support/lavish.ts";
import { configureMain, Scratch } from "../support/scratch.ts";

const LAVISH_START_MS = 60_000;
const BOARD = fileURLToPath(new URL("../../packages/board/dist", import.meta.url));
const PAGE_HTML = "<html style='background:#fff;color:#111'><body><h1>Plan</h1></body></html>";

let fleet: Fleet;
let h: Harness;
let lab: HerdrLab;
let env: Record<string, string>;
let lavish: Record<string, string>;
let lavishServer: Lavish;
let card: Card;
let scratch: Scratch;
let browser: Browser;
let board: Page;

before(async () => {
  browser = await chromium.launch();
});
after(async () => {
  await browser.close();
});

const startWorker = () =>
  h.startPi(`c-${String(card.id)}-a1`, env, [
    join(scratch.root, "packages/extension/src/index.ts"),
  ]);
const settled = (n: number) =>
  h.waitForNth((event) => event["type"] === "settled", n, `settle ${String(n)}`);
const view = async () => check(OPS.card.result, await fleet.main.call("card", { card: card.id }));
const needsYou = () => board.getByRole("region", { name: "Needs you" });

async function reviewWrapper(): Promise<number> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      const output = execFileSync(
        "pgrep",
        ["-f", join(scratch.root, "packages/extension/src/job.ts")],
        { encoding: "utf8" },
      );
      const [pid] = output.trim().split("\n").map(Number);
      if (pid !== undefined) return pid;
    } catch {
      if (Date.now() > deadline) throw new Error("the review wrapper did not start");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function reviewPollStopped(): Promise<void> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      execFileSync("pgrep", ["-f", `lavish-axi poll ${join(h.dir, "plan.html")}`]);
    } catch {
      return;
    }
    if (Date.now() > deadline) throw new Error("the canceled review poll is still running");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

beforeEach(async () => {
  scratch = new Scratch();
  const cardd = await Cardd.start({ CARDD_TIMING_SCALE: "0.1" }, ["--board", BOARD]);
  const mainToken = cardd.addLane("main", undefined, scratch.root);
  cardd.addProject("web", { maverick: scratch.root });
  fleet = { cardd, mainToken, main: await cardd.connect(mainToken) };
  configureMain(scratch, cardd.url, mainToken);
  board = await browser.newPage();
  await board.goto(cardd.url.replace(/^ws/, "http").replace(/\/session$/, "/"));
  h = await Harness.start();
  lavishServer = await Lavish.start(h.dir);
  lavish = lavishServer.env;
  lab = await HerdrLab.start(lavish);
  const created = await lab.run(["workspace", "create", "--no-focus"]);
  const [workspace] = records([created["workspace"]]).map((each) => each["workspace_id"]);
  if (typeof workspace !== "string") throw new Error("the lab returned no workspace");
  card = await newCard(fleet.main, "Plan the onboarding redesign", "scout");
  const token = await begin(fleet.main, card, "show the captain the plan");
  env = {
    ...lavish,
    FLEET_URL: fleet.cardd.url,
    FLEET_TOKEN: token,
    FLEET_ROLE: "worker",
    HERDR_SESSION: lab.name,
    HERDR_WORKSPACE_ID: workspace,
  };
});
afterEach(async (t) => {
  if ("passed" in t && !t.passed)
    t.diagnostic(
      JSON.stringify(
        h.calls.map((turns) =>
          turns.slice(-2).map((turn) => ({ role: turn.role, text: turn.text.slice(0, 1000) })),
        ),
        null,
        2,
      ),
    );
  await lab.printIfFailed(t);
  await board.close();
  const stopped = await Promise.allSettled([lab.stop(), h.stop(), fleet.cardd.stop()]);
  scratch.dispose();
  await lavishServer.stop();
  const failed = stopped.find((result) => result.status === "rejected");
  if (failed !== undefined) throw new Error(`cleanup failed: ${String(failed.reason)}`);
});

const lastUser = (turns: Turn[]): string =>
  turns.findLast((turn) => turn.role === "user")?.text ?? "";

async function captainSends(pageUrl: string, body: Record<string, unknown>): Promise<void> {
  const key = new URL(pageUrl).pathname.split("/").at(-1) ?? "";
  const origin = `http://127.0.0.1:${lavish["LAVISH_AXI_PORT"] ?? ""}`;
  const response = await fetch(`${origin}/api/${key}/prompts`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 200, await response.text());
}

function repliesOnPage(): string[] {
  const state = parseRecord(
    readFileSync(join(lavish["LAVISH_AXI_STATE_DIR"] ?? "", "state.json"), "utf8"),
  );
  const sessions = isRecord(state["sessions"]) ? Object.values(state["sessions"]) : [];
  return records(sessions)
    .flatMap((session) => records(session["chat"]))
    .filter((message) => message["role"] === "agent")
    .map((message) => String(message["text"]));
}

async function escalateReview(): Promise<string> {
  const hold = (await view()).hold;
  assert.notEqual(hold, null);
  const question = hold?.question ?? "";
  await fleet.main.call("hold", { card: card.id, question, to: "captain" });
  return /(https?:\/\/\S+\/session\/\w+)/.exec(question)?.[1] ?? "";
}

test("a worker answers the captain's feedback on its review page, and is done only when the review ends", async () => {
  const page = join(h.dir, "plan.html");
  writeFileSync(page, PAGE_HTML);
  let whileAnswering: Card["status"] | undefined;
  h.onModel(() => ({ tool: "wait_review", args: { file: page } }));
  h.onModel(() => ({ text: "The plan is on the captain's page." }));
  h.onModel(async () => {
    whileAnswering = await status(fleet.main, card);
    return { tool: "wait_review", args: { file: page, reply: "Made the title red." } };
  });
  h.onModel(() => ({ tool: "report", args: { status: "done", text: "plan delivered" } }));
  h.onModel(() => ({ text: "Waiting for the captain to finish the review." }));
  h.onModel(() => ({ tool: "report", args: { status: "done", text: "the captain approved it" } }));
  h.onModel(() => ({ text: "Done." }));
  startWorker();

  const afterOpen = await h.waitForCall(1, "default", LAVISH_START_MS);
  assert.match(afterOpen.at(-1)?.text ?? "", /The page is open for the captain at http/);
  await settled(1);
  const pageUrl = await escalateReview();
  await needsYou().getByRole("article").filter({ hasText: pageUrl }).waitFor();

  await captainSends(pageUrl, { prompts: [{ tag: "message", prompt: "Make the title red" }] });
  const feedback = lastUser(await h.waitForCall(2));
  assert.match(feedback, /^\[fleet\] captain on c-1 plan-the-onboarding-redesign \(review page\):/);
  assert.match(feedback, /Make the title red/);
  assert.doesNotMatch(feedback, /lavish-axi poll/);

  const next = await fleet.main.waitForEntry(
    (entry) => entry.fields["key"] === "review-2",
    "the second round's decision",
  );
  assert.equal(next.fields["status"], "needs-decision");
  assert.equal(whileAnswering, "working");
  assert.deepEqual(repliesOnPage(), ["Made the title red."]);
  await escalateReview();
  const refused = await h.waitForCall(4);
  assert.match(refused.at(-1)?.text ?? "", /review page is still open/);
  await settled(2);

  await captainSends(pageUrl, {
    prompts: [{ tag: "message", prompt: "Looks good, ship it" }],
    endSession: true,
  });
  const done = await fleet.main.waitForEntry(
    (entry) => entry.fields["status"] === "done",
    "the worker's done",
  );
  assert.equal(done.body, "the captain approved it");
  assert.match(lastUser(h.calls[5] ?? []), /Looks good, ship it/);
  await needsYou().getByRole("article").waitFor({ state: "detached" });
  const holds = (await fleet.cardd.board()).holds;
  assert.equal(holds.length, 0);
});

for (const tool of ["wait_review", "run_long"]) {
  test(`${tool}: the review wait holds a paused worker's card for the captain, and feedback clears it`, async () => {
    const owner =
      tool === "run_long"
        ? await fleet.cardd.connect(
            fleet.cardd.addLane("cleo", "main", join(scratch.parent, "cleo")),
          )
        : fleet.main;
    if (tool === "run_long") {
      card = await newCard(owner, "Review the lane's plan", "scout");
      env["FLEET_TOKEN"] = await begin(owner, card, "show the captain the plan");
    }
    const page = join(h.dir, "plan.html");
    writeFileSync(page, PAGE_HTML);
    const opened = execFileSync("lavish-axi", [page, "--no-open"], {
      env: { ...process.env, ...lavish },
      encoding: "utf8",
    });
    const pageUrl = /(https?:\/\/\S+\/session\/\w+)/.exec(opened)?.[1] ?? "";
    assert.match(pageUrl, /\/session\/\w+$/);
    let whileAnswering: Card["status"] | undefined;
    h.onModel(() => ({
      tool,
      args:
        tool === "wait_review"
          ? { file: page }
          : { label: "poll", command: `lavish-axi poll '${page}' --owner somebody` },
    }));
    h.onModel(async () => {
      const hold = (await view()).hold;
      if (hold !== null) {
        if (tool === "run_long") {
          await owner.call("hold", { card: card.id, question: hold.question });
          const forwarded = await fleet.main.waitForEntry(
            (entry) => entry.card === card.id && entry.kind === "hold",
            "the lane's review hold",
          );
          assert.equal(forwarded.fields["holder"], "main");
        }
        await escalateReview();
      }
      return { tool: "report", args: { status: "paused", text: "waiting on the captain's page" } };
    });
    h.onModel(() => ({ text: "Waiting for the captain." }));
    h.onModel(async () => {
      whileAnswering = await status(fleet.main, card);
      return {
        tool: "report",
        args: {
          status: "paused",
          text: "feedback taken",
          until: new Date(Date.now() + 60_000).toISOString(),
        },
      };
    });
    h.onModel(() => ({ text: "Feedback received." }));
    startWorker();

    await h.waitForCall(2, "default", LAVISH_START_MS);
    await settled(1);
    assert.equal(await status(fleet.main, card), "needs-you");
    assert.equal((await view()).hold?.holder, "captain");
    assert.ok((await view()).hold?.question.includes(pageUrl));
    const article = needsYou().getByRole("article").filter({ hasText: pageUrl });
    await article.waitFor();
    assert.equal(await needsYou().getByRole("article").count(), 1);
    for (const report of ["working", "needs-decision"]) {
      await fleet.cardd.post(env["FLEET_TOKEN"] ?? "", "report", {
        status: report,
        text: "still reviewing",
        ...(report === "needs-decision" ? { key: "review-1" } : {}),
      });
      assert.equal(await status(fleet.main, card), "needs-you");
      assert.equal((await fleet.cardd.board()).holds.length, 1);
    }
    await captainSends(pageUrl, { prompts: [{ tag: "message", prompt: "Looks fine" }] });
    await settled(2);
    assert.equal(whileAnswering, "working");
    assert.equal((await view()).hold, null);
    await article.waitFor({ state: "detached" });
  });
}

test("poll commands with shell work or reply options are refused before they can become unheld jobs", async () => {
  const page = join(h.dir, "plan.html");
  const commands = [
    `cd /tmp && lavish-axi poll '${page}'`,
    `lavish-axi poll '${page}' --agent-reply 'Do not lose this reply'`,
    `/usr/local/bin/lavish-axi poll '${page}'`,
  ];
  for (const command of commands) {
    h.onModel(() => ({ tool: "run_long", args: { label: "poll", command } }));
  }
  h.onModel(() => ({ tool: "report", args: { status: "blocked", text: "use wait_review" } }));
  h.onModel(() => ({ text: "Refused." }));
  startWorker();
  await settled(1);
  for (let index = 1; index <= commands.length; index += 1) {
    const result = (await h.waitForCall(index)).at(-1)?.text ?? "";
    assert.match(result, /wait on a review page with wait_review, not a lavish-axi poll job/);
  }
  const jobs = await fleet.cardd.post(env["FLEET_TOKEN"] ?? "", "jobs", {});
  assert.deepEqual(jobs.body, { ok: true, value: [] });
  assert.equal((await view()).hold, null);
});

test("a replaced worker leaves no stale review hold behind", async () => {
  const page = join(h.dir, "plan.html");
  writeFileSync(page, PAGE_HTML);
  h.onModel(() => ({ tool: "wait_review", args: { file: page } }));
  h.onModel(() => ({ text: "The plan is on the captain's page." }));
  startWorker();
  await h.waitForCall(1, "default", LAVISH_START_MS);
  await settled(1);
  const pageUrl = await escalateReview();
  const article = needsYou().getByRole("article").filter({ hasText: pageUrl });
  await article.waitFor();
  await fleet.main.call("attempt.begin", {
    card: card.id,
    host: "maverick",
    task: "start over",
    replace: true,
  });
  assert.equal(await status(fleet.main, card), "working");
  assert.equal((await view()).hold, null);
  await article.waitFor({ state: "detached" });
});

test("stopping the worker clears its review hold and stops its poll", async () => {
  const page = join(h.dir, "plan.html");
  writeFileSync(page, PAGE_HTML);
  const stop = gate();
  h.onModel(() => ({ tool: "wait_review", args: { file: page } }));
  h.onModel(() => ({ text: "The plan is on the captain's page." }));
  h.onModel(async () => {
    await stop.wait;
    return { text: "aborted" };
  });
  const worker = startWorker();
  await h.waitForCall(1, "default", LAVISH_START_MS);
  await settled(1);
  const pageUrl = await escalateReview();
  await needsYou().getByRole("article").filter({ hasText: pageUrl }).waitFor();
  try {
    worker.prompt("stop this wait");
    await h.waitForCall(2);
    worker.abort();
    await fleet.main.waitForEntry(
      (entry) => entry.fields["status"] === "stopped",
      "the worker stopped",
    );
    assert.equal(await status(fleet.main, card), "with-mate");
    assert.equal((await view()).hold, null);
    await needsYou().getByRole("article").waitFor({ state: "detached" });
    const token = env["FLEET_TOKEN"] ?? "";
    const jobs = await fleet.cardd.post(token, "jobs", {});
    assert.deepEqual(jobs.body, { ok: true, value: [] });
    await reviewPollStopped();
  } finally {
    stop.open();
  }
});

test("a review job that misses its heartbeats leaves no stale hold", async () => {
  const page = join(h.dir, "plan.html");
  writeFileSync(page, PAGE_HTML);
  h.onModel(() => ({ tool: "wait_review", args: { file: page } }));
  h.onModel(() => ({ text: "The plan is on the captain's page." }));
  h.onModel(() => ({ tool: "report", args: { status: "blocked", text: "the poll died" } }));
  h.onModel(() => ({ text: "The poll died." }));
  startWorker();
  await h.waitForCall(1, "default", LAVISH_START_MS);
  await settled(1);
  await escalateReview();
  const wrapper = await reviewWrapper();
  process.kill(wrapper, "SIGSTOP");
  try {
    const lost = lastUser(await h.waitForCall(2, "default", 20_000));
    assert.match(lost, /job 1 \(review\) lost/);
    await settled(2);
    assert.equal((await view()).hold, null);
    await needsYou().getByRole("article").waitFor({ state: "detached" });
  } finally {
    process.kill(wrapper, "SIGCONT");
  }
});

test("closing the review tab ends the wait, and the hold goes with it", async () => {
  const page = join(h.dir, "plan.html");
  writeFileSync(page, PAGE_HTML);
  let whileResuming: Card["status"] | undefined;
  h.onModel(() => ({ tool: "wait_review", args: { file: page } }));
  h.onModel(() => ({ text: "The plan is on the captain's page." }));
  h.onModel(async () => {
    whileResuming = await status(fleet.main, card);
    return { tool: "report", args: { status: "failed", text: "the review wait ended" } };
  });
  h.onModel(() => ({ text: "Done." }));
  startWorker();
  await h.waitForCall(1, "default", LAVISH_START_MS);
  await settled(1);
  await escalateReview();
  const listed = await lab.run(["tab", "list", "--workspace", env["HERDR_WORKSPACE_ID"] ?? ""]);
  const tab = records(listed["tabs"]).find((each) => each["label"] === "job-1-review");
  assert.equal(typeof tab?.["tab_id"], "string");
  await lab.run(["tab", "close", String(tab?.["tab_id"])]);
  const ended = await h.waitForCall(2, "default", 20_000);
  assert.match(lastUser(ended), /job 1 \(review\) (exited 130|lost)/);
  await settled(2);
  assert.equal(whileResuming, "working");
  assert.equal((await view()).hold, null);
  await needsYou().getByRole("article").waitFor({ state: "detached" });
});
