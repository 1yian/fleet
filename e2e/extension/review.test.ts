import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import type { Card } from "@fleet/protocol";
import { begin, newCard, startFleet, status, type Fleet } from "../support/fleet.ts";
import { Harness, type Turn } from "../support/harness.ts";
import { HerdrLab } from "../support/herdr.ts";
import { isRecord, parseRecord, records } from "../support/json.ts";

const LAVISH_START_MS = 60_000;
const EXTENSION = fileURLToPath(new URL("../../packages/extension/src/index.ts", import.meta.url));

let fleet: Fleet;
let h: Harness;
let lab: HerdrLab;
let env: Record<string, string>;
let lavish: Record<string, string>;
let card: Card;

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  if (address === null || typeof address === "string") throw new Error("no free port");
  return address.port;
}

beforeEach(async () => {
  fleet = await startFleet({ CARDD_TIMING_SCALE: "0.04" });
  h = await Harness.start();
  lavish = {
    LAVISH_AXI_STATE_DIR: join(h.dir, "lavish"),
    LAVISH_AXI_PORT: String(await freePort()),
    LAVISH_AXI_NO_OPEN: "1",
  };
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
  await lab.printIfFailed(t);
  const stopped = await Promise.allSettled([lab.stop(), h.stop(), fleet.cardd.stop()]);
  execFileSync("lavish-axi", ["stop"], { env: { ...process.env, ...lavish }, stdio: "ignore" });
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

test("a worker answers the captain's feedback on its review page, and is done only when the review ends", async () => {
  const page = join(h.dir, "plan.html");
  writeFileSync(page, "<html style='background:#fff;color:#111'><body><h1>Plan</h1></body></html>");
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
  h.startPi("c-1-a1", env, [EXTENSION]);

  const afterOpen = await h.waitForCall(1, "default", LAVISH_START_MS);
  assert.match(afterOpen.at(-1)?.text ?? "", /The page is open for the captain at http/);

  const opened = await fleet.main.waitForEntry(
    (entry) => entry.fields["status"] === "needs-decision",
    "the first round's decision",
  );
  assert.equal(opened.fields["key"], "review-1");
  const pageUrl = /(https?:\/\/\S+\/session\/\w+)/.exec(opened.body)?.[1] ?? "";
  assert.match(pageUrl, /\/session\/\w+$/);
  assert.equal(await status(fleet.main, card), "with-mate");

  await captainSends(pageUrl, { prompts: [{ tag: "message", prompt: "Make the title red" }] });
  const feedback = lastUser(await h.waitForCall(2));
  assert.match(feedback, /^\[fleet\] captain on c-1 \(review page\):/);
  assert.match(feedback, /Make the title red/);
  assert.doesNotMatch(feedback, /lavish-axi poll/);

  const next = await fleet.main.waitForEntry(
    (entry) => entry.fields["key"] === "review-2",
    "the second round's decision",
  );
  assert.equal(next.fields["status"], "needs-decision");
  assert.equal(whileAnswering, "working");
  assert.deepEqual(repliesOnPage(), ["Made the title red."]);

  const refused = await h.waitForCall(4);
  assert.match(refused.at(-1)?.text ?? "", /review page is still open/);

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
  assert.deepEqual(
    fleet.main.entries.map(({ entry }) => [entry.fields["status"], entry.fields["key"] ?? null]),
    [
      ["needs-decision", "review-1"],
      ["needs-decision", "review-2"],
      ["done", null],
    ],
  );
});
