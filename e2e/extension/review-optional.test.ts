import assert from "node:assert/strict";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { toolResults } from "../support/dispatch-lab.ts";
import { begin, newCard, type Fleet } from "../support/fleet.ts";
import { Harness } from "../support/harness.ts";
import { HerdrLab } from "../support/herdr.ts";
import { Cardd } from "../support/cardd.ts";
import { configureMain, Scratch } from "../support/scratch.ts";
import { pathWithout } from "../support/tool-stubs.ts";

const HOST = hostname();
const PLAN = "/tmp/fleet-c-1/review.md";

let fleet: Fleet;
let h: Harness;
let lab: HerdrLab;
let scratch: Scratch;
let token: string;
beforeEach(async () => {
  scratch = new Scratch();
  const cardd = await Cardd.start();
  const mainToken = cardd.addLane("main", undefined, scratch.root);
  cardd.addProject("web", { maverick: scratch.root });
  fleet = { cardd, mainToken, main: await cardd.connect(mainToken) };
  configureMain(scratch, cardd.url, mainToken);
  h = await Harness.start();
  lab = await HerdrLab.start({});
  const created = await lab.run(["workspace", "create", "--no-focus"]);
  const workspace = String(Reflect.get(Object(created["workspace"]), "workspace_id"));
  const card = await newCard(fleet.main, "Plan the onboarding redesign", "scout");
  token = await begin(fleet.main, card, "show the captain the plan");
  workerEnv = {
    FLEET_URL: cardd.url,
    FLEET_TOKEN: token,
    FLEET_ROLE: "worker",
    HERDR_SESSION: lab.name,
    HERDR_WORKSPACE_ID: workspace,
  };
});
afterEach(async (t) => {
  await lab.printIfFailed(t);
  const stopped = await Promise.allSettled([lab.stop(), h.stop(), fleet.cardd.stop()]);
  scratch.dispose();
  const failed = stopped.find((result) => result.status === "rejected");
  if (failed !== undefined) throw new Error(`cleanup failed: ${String(failed.reason)}`);
});

let workerEnv: Record<string, string>;

function oldLavish(): string {
  const bin = join(h.dir, "old-lavish");
  mkdirSync(bin);
  writeFileSync(join(bin, "lavish-axi"), "#!/bin/sh\necho 0.1.10\n");
  chmodSync(join(bin, "lavish-axi"), 0o755);
  return [bin, pathWithout("lavish-axi")].join(delimiter);
}

const hosts: readonly { name: string; path: () => string; why: string }[] = [
  {
    name: "missing",
    path: () => pathWithout("lavish-axi"),
    why: `lavish-axi is missing on ${HOST}. Fix: npm install -g lavish-axi`,
  },
  {
    name: "too old",
    path: oldLavish,
    why: `lavish-axi 0.1.10 is too old on ${HOST} (need 0.1.80 or later). Fix: npm install -g lavish-axi`,
  },
];
const requests: readonly { tool: string; args: () => Record<string, string> }[] = [
  { tool: "wait_review", args: () => ({ file: join(h.dir, "plan.html") }) },
  {
    tool: "run_long",
    args: () => ({ label: "poll", command: `lavish-axi poll '${join(h.dir, "plan.html")}'` }),
  },
];

for (const host of hosts) {
  for (const request of requests) {
    test(`${request.tool} on a host whose lavish-axi is ${host.name} tells the worker to write a plain report, and strands no hold`, async () => {
      writeFileSync(join(h.dir, "plan.html"), "<html><body><h1>Plan</h1></body></html>");
      h.onModel(() => ({ tool: request.tool, args: request.args() }));
      h.onModel(() => ({
        tool: "report",
        args: {
          status: "needs-decision",
          key: "plan-review",
          text: `lavish-axi is unavailable, so the plan is in ${PLAN}`,
        },
      }));
      h.onModel(() => ({ text: "The plan is in a plain report." }));
      h.startPi("c-1-a1", { ...workerEnv, PATH: host.path() }, [
        join(scratch.root, "packages/extension/src/index.ts"),
      ]);

      const result = toolResults(await h.waitForCall(1)).at(-1) ?? "";
      assert.ok(result.includes(host.why), result);
      assert.match(result, /no review page was opened and no review wait was started/);
      assert.match(result, /Do not retry wait_review and do not run lavish-axi yourself/);
      assert.match(result, /plain Markdown report file/);
      assert.match(result, /report needs-decision/);

      const entry = await fleet.main.waitForEntry(
        (each) => each.fields["key"] === "plan-review",
        "the worker's plain report",
      );
      assert.equal(entry.fields["status"], "needs-decision");
      assert.deepEqual((await fleet.cardd.board()).holds, []);
      assert.deepEqual((await fleet.cardd.post(token, "jobs", {})).body, { ok: true, value: [] });
      await h.waitForCall(2);
    });
  }
}
