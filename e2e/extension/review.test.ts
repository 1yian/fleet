import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { check, OPS } from "@fleet/protocol";
import { Cardd } from "../support/cardd.ts";
import { begin, newCard, type Fleet } from "../support/fleet.ts";
import { gate, Harness } from "../support/harness.ts";
import { HerdrLab } from "../support/herdr.ts";
import { records } from "../support/json.ts";
import { Lavish } from "../support/lavish.ts";
import { Scratch } from "../support/scratch.ts";

let fleet: Fleet;
let h: Harness;
let lab: HerdrLab;
let scratch: Scratch;
let lavish: Lavish;
let env: Record<string, string>;
beforeEach(async () => {
  scratch = new Scratch();
  const cardd = await Cardd.start();
  const mainToken = cardd.addLane("main");
  cardd.addProject("web", { maverick: scratch.root });
  fleet = { cardd, mainToken, main: await cardd.connect(mainToken) };
  h = await Harness.start();
  lavish = await Lavish.start(h.dir);
  lab = await HerdrLab.start(lavish.env);
  const created = await lab.run(["workspace", "create", "--no-focus"]);
  const workspace = records([created["workspace"]])[0]?.["workspace_id"];
  if (typeof workspace !== "string") throw new Error("the lab returned no workspace");
  const card = await newCard(fleet.main, "Review the plan", "scout");
  env = {
    ...lavish.env,
    FLEET_URL: cardd.url,
    FLEET_TOKEN: await begin(fleet.main, card),
    FLEET_ROLE: "worker",
    HERDR_SESSION: lab.name,
    HERDR_WORKSPACE_ID: workspace,
  };
});
afterEach(async (t) => {
  await lab.printIfFailed(t);
  await lab.stop();
  await h.stop();
  await fleet.cardd.stop();
  await lavish.stop();
  scratch.dispose();
});

test("readiness reaches the mate before polling and captain feedback submitted between timed-out polls is retained", async () => {
  const page = join(h.dir, "plan.html");
  writeFileSync(page, "<html><body><h1>Plan</h1></body></html>");
  const opened = execFileSync("lavish-axi", [page, "--no-open"], {
    env: { ...process.env, ...lavish.env },
    encoding: "utf8",
  });
  const url = /(https?:\/\/\S+\/session\/\w+)/.exec(opened)?.[1] ?? "";
  assert.match(url, /\/session\/\w+$/);
  const between = gate();
  const submitted = gate();
  const command = `lavish-axi poll '${page}' --owner fleet-c-1`;
  h.onModel(() => ({
    tool: "report",
    args: { status: "needs-decision", key: "plan-review", text: `Review ready: ${url}` },
  }));
  h.onModel(() => ({
    tool: "run_long",
    args: { label: "review", command, timeout_minutes: 0.05 },
  }));
  h.onModel(() => ({ text: "Waiting for feedback." }));
  h.onModel(async (turns) => {
    assert.match(turns.findLast((turn) => turn.role === "user")?.text ?? "", /exited 124/);
    between.open();
    await submitted.wait;
    return { tool: "run_long", args: { label: "review", command, timeout_minutes: 2 } };
  });
  h.onModel(() => ({ text: "Polling again." }));
  h.onModel((turns) => {
    assert.match(
      turns.findLast((turn) => turn.role === "user")?.text ?? "",
      /Make the heading blue/,
    );
    return {
      tool: "report",
      args: {
        status: "needs-decision",
        key: "plan-review-2",
        text: "Feedback delivered: Make the heading blue",
      },
    };
  });
  h.onModel(() => ({ text: "Review retained." }));
  h.startPi("c-1-a1", env, [join(scratch.root, "packages/extension/src/index.ts")]);
  const ready = await fleet.main.waitForEntry(
    (entry) => entry.fields["key"] === "plan-review",
    "review readiness",
  );
  assert.equal(ready.body, `Review ready: ${url}`);
  await between.wait;
  const origin = `http://127.0.0.1:${lavish.env["LAVISH_AXI_PORT"] ?? ""}`;
  const key = new URL(url).pathname.split("/").at(-1) ?? "";
  const response = await fetch(`${origin}/api/${key}/prompts`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ prompts: [{ tag: "message", prompt: "Make the heading blue" }] }),
  });
  assert.equal(response.status, 200, await response.text());
  submitted.open();
  await fleet.main.waitForEntry(
    (entry) => entry.body === "Feedback delivered: Make the heading blue",
    "feedback after the polling gap",
  );
  const result = await h.waitForCall(6, "default", 60_000);
  assert.ok(result.some((turn) => turn.text.includes("Make the heading blue")));
  assert.equal(
    check(OPS.card.result, await fleet.main.call("card", { card: 1 })).card.status,
    "with-mate",
  );
});
