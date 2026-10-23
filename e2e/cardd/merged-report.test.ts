import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { CardSchema, check, OPS, type Card, type Entry } from "@fleet/protocol";
import { tempDir } from "../support/run-root.ts";
import { begin, newCard, startFleet, status, type Fleet } from "../support/fleet.ts";

let fleet: Fleet;
beforeEach(async () => {
  fleet = await startFleet({ CARDD_TIMING_SCALE: "0.001" });
});
afterEach(async () => {
  await fleet.cardd.stop();
});

const reportOf = (card: Card): Promise<Entry> =>
  fleet.main.waitForEntry(
    (entry) => entry.card === card.id && entry.kind === "report",
    `the report on c-${String(card.id)}`,
  );
const findingFor = (card: Card, condition: string): Promise<Entry> =>
  fleet.main.waitForEntry(
    (entry) => entry.card === card.id && entry.fields["condition"] === condition,
    `${condition} on c-${String(card.id)}`,
  );
const closePlan = async (card: Card) =>
  check(OPS["close.begin"].result, await fleet.main.call("close.begin", { card: card.id }));

test("a merged report for a PR from another branch is verified and the card closes as Done without branch checks", async () => {
  const pr = "https://github.com/acme/web/pull/381";
  fleet.cardd.gh.setPr(pr, "MERGED");
  fleet.cardd.gh.setHead(pr, "cleo-other-card");
  const card = await newCard(fleet.main, "Mercedes");
  const worker = await fleet.cardd.connect(await begin(fleet.main, card));
  await worker.call("report", { status: "merged", text: "landed in another card", pr });

  const report = await reportOf(card);
  assert.equal(report.fields["status"], "merged");
  assert.equal(report.fields["prState"], "MERGED");
  await findingFor(card, "pr-merged");
  assert.equal(await status(fleet.main, card), "with-mate");
  const plan = await closePlan(card);
  assert.equal(plan.mode, "done");
  assert.equal(plan.verify, false);
  const reminder = await findingFor(card, "finished-1");
  assert.match(reminder.body, /Close it now with close\(card, summary\)\.$/);
});

test("merged without a URL, and merged with a PR that has not merged, count as done with the close and confirm nag", async () => {
  const open = "https://github.com/acme/web/pull/9";
  fleet.cardd.gh.setPr(open, "OPEN", { ci: "pass" });
  const bare = await newCard(fleet.main, "no url");
  const bareWorker = await fleet.cardd.connect(await begin(fleet.main, bare));
  await bareWorker.call("report", { status: "merged", text: "merged it" });
  const report = await reportOf(bare);
  assert.equal(report.fields["status"], "done");
  assert.match(String(report.fields["prNote"]), /without a PR URL/);
  const reminder = await findingFor(bare, "finished-1");
  assert.match(
    reminder.body,
    /call close again with confirm=true\. If it never landed and will not, close\(card, summary=<why>, landed=false\)\.$/,
  );
  assert.doesNotMatch(reminder.body, /open one/);

  const unmerged = await newCard(fleet.main, "open pr");
  const worker = await fleet.cardd.connect(await begin(fleet.main, unmerged));
  await worker.call("report", { status: "merged", text: "merged it", pr: open });
  const second = await fleet.main.waitForEntry(
    (entry) => entry.card === unmerged.id && entry.kind === "report",
    "the report",
  );
  assert.equal(second.fields["status"], "done");
  assert.match(String(second.fields["prNote"]), /has not merged, so the report counts as done/);
});

test("the merged check runs with the clone's direnv account, and a PR that account cannot see is PR unknown", async () => {
  const clone = join(tempDir("fleet-cnp-"), "site");
  mkdirSync(clone);
  writeFileSync(join(clone, ".envrc"), "export GH_TOKEN=cnp\n");
  fleet.cardd.addProject("cnp", { maverick: clone }, "cnp/site");
  const seen = "https://github.com/cnp/site/pull/1";
  const hidden = "https://github.com/cnp/site/pull/2";
  fleet.cardd.gh.setPr(seen, "MERGED");
  fleet.cardd.gh.only(seen, "cnp");
  fleet.cardd.gh.setPr(hidden, "MERGED");
  fleet.cardd.gh.only(hidden, "1yian");

  const make = async (title: string): Promise<Card> =>
    check(CardSchema, await fleet.main.call("card.new", { title, kind: "ship", project: "cnp" }));
  const visible = await make("visible");
  const visibleWorker = await fleet.cardd.connect(await begin(fleet.main, visible));
  await visibleWorker.call("report", { status: "merged", text: "merged", pr: seen });
  assert.equal((await reportOf(visible)).fields["status"], "merged");

  const invisible = await make("invisible");
  const invisibleWorker = await fleet.cardd.connect(await begin(fleet.main, invisible));
  await invisibleWorker.call("report", { status: "merged", text: "merged", pr: hidden });
  const report = await reportOf(invisible);
  assert.equal(report.fields["status"], "done");
  assert.match(
    String(report.fields["prNote"]),
    /^PR unknown: .*Could not resolve.*counts as done$/,
  );
  assert.equal((await closePlan(invisible)).verify, true);
});
