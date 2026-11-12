import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Captain, GuardLab, until } from "../support/guard-lab.ts";

const SECRET = "hunter2-secret-value";
const READ_PASSWORD = "document.querySelector('#pw').value";

let lab: GuardLab;

before(async () => {
  lab = await GuardLab.start([], { relay: true });
});
after(async () => {
  await lab.stop();
});

test("a worker that stays connected while the guard loses sight of Chrome is refused until the guard sees again", async () => {
  const relay = lab.relay;
  assert.ok(relay, "the lab has no relay in front of Chrome");
  const worker = await lab.worker();
  const tab = await lab.openPage(worker, "/login", "login");
  const captain = await Captain.at(lab.chrome, tab.target);
  await captain.click("#pw");
  await captain.type(SECRET);
  await until(async () => {
    const reply = await worker.evaluate(tab.session, READ_PASSWORD);
    return reply.ok ? undefined : true;
  }, "the guard to arm");

  relay.blindTheMonitor();
  const blind = await until(async () => {
    const reply = await worker.evaluate(tab.session, READ_PASSWORD);
    return !reply.ok && reply.text.includes("not ready") ? reply : undefined;
  }, "the guard to refuse while it cannot see Chrome");
  assert.ok(!blind.text.includes(SECRET));

  relay.restoreTheMonitor();
  const seen = await until(async () => {
    const reply = await worker.evaluate(tab.session, READ_PASSWORD);
    return !reply.ok && /captain.*password/i.test(reply.text) ? reply : undefined;
  }, "the guard to see the typed password again");
  assert.ok(!seen.text.includes(SECRET));

  await captain.erase(SECRET.length);
  await captain.click("#user");
  const emptied = await until(async () => {
    const reply = await worker.evaluate(tab.session, READ_PASSWORD);
    return reply.ok ? reply : undefined;
  }, "the read to work once the field is empty");
  assert.equal(emptied.text, '""');
  captain.close();
});
