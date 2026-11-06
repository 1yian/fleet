import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { CardSchema, check, type Card, type Entry } from "@fleet/protocol";
import { Cardd, type Session } from "../support/cardd.ts";
import { begin } from "../support/fleet.ts";
import { MuxSsh } from "../support/mux-ssh.ts";
import { tempDir } from "../support/run-root.ts";

let cardd: Cardd;
let main: Session;
let ssh: MuxSsh;
beforeEach(async () => {
  ssh = new MuxSsh();
  const hosts = { local: ["sh", "-c"], maverick: [join(ssh.bin, "ssh"), "maverick"] };
  cardd = await Cardd.start({ CARDD_TIMING_SCALE: "0.001" }, ["--hosts", JSON.stringify(hosts)]);
  const clone = join(tempDir("fleet-mux-site-"), "site");
  mkdirSync(clone);
  writeFileSync(join(clone, ".envrc"), "export GH_TOKEN=cnp\n");
  cardd.addProject("cnp", { maverick: clone }, "cnp/site");
  main = await cardd.connect(cardd.addLane("main"));
});
afterEach(async () => {
  await cardd.stop();
});

async function mergedReport(url: string): Promise<{ card: Card; report: Entry }> {
  const card = check(
    CardSchema,
    await main.call("card.new", { title: "ship it", kind: "ship", project: "cnp" }),
  );
  const worker = await cardd.connect(await begin(main, card, "the task", "maverick"));
  await worker.call("report", { status: "merged", text: "merged", pr: url });
  const report = await main.waitForEntry(
    (entry) => entry.card === card.id && entry.kind === "report",
    "the report",
  );
  return { card, report };
}

test("a merged report is verified on a host whose ssh master refuses file descriptors, by retrying once without the master", async () => {
  const pr = "https://github.com/cnp/site/pull/1";
  cardd.gh.setPr(pr, "MERGED");
  ssh.mode = "wedged";

  const { report } = await mergedReport(pr);

  assert.equal(report.fields["status"], "merged");
  assert.equal(report.fields["merged"], true);
  assert.deepEqual(
    ssh.calls().map((call) => call.direct),
    [false, true],
  );
  assert.equal(ssh.calls()[0]?.command, ssh.calls()[1]?.command);
});

test("a merged report is not replayed when ssh fell back to a direct connection by itself and the connection then dropped", async () => {
  const pr = "https://github.com/cnp/site/pull/3";
  cardd.gh.setPr(pr, "MERGED");
  ssh.mode = "fell-back-then-dropped";

  const { report } = await mergedReport(pr);

  assert.equal(report.fields["status"], "done");
  assert.match(
    String(report.fields["prNote"]),
    /^PR unknown: .*master hello exchange failed.*counts as done$/,
  );
  assert.deepEqual(
    ssh.calls().map((call) => call.direct),
    [false],
  );
});

test("a merged report on a host that cannot be reached still counts as done with the PR unknown, and names the retry's reason", async () => {
  const pr = "https://github.com/cnp/site/pull/2";
  cardd.gh.setPr(pr, "MERGED");
  ssh.mode = "wedged-down";

  const { report } = await mergedReport(pr);

  assert.equal(report.fields["status"], "done");
  assert.match(
    String(report.fields["prNote"]),
    /^PR unknown: .*Operation timed out.*counts as done$/,
  );
  assert.doesNotMatch(String(report.fields["prNote"]), /Message too long/);
  assert.deepEqual(
    ssh.calls().map((call) => call.direct),
    [false, true],
  );
});
