import assert from "node:assert/strict";
import { once } from "node:events";
import { request } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, test } from "node:test";
import { CardSchema, check, CLOSE } from "@fleet/protocol";
import type { Session } from "../support/cardd.ts";
import { begin, newCard, startFleet, type Fleet } from "../support/fleet.ts";
import type { FakeIssue } from "../support/github.ts";
import { poll } from "../support/harness.ts";

const REPO = "github.com/1yian/fleet";
let fleet: Fleet;
let cleo: Session;
let worker: Session;
let workerCard: number;
let workerToken: string;
beforeEach(async () => {
  fleet = await startFleet({ GH_HOST: "enterprise.example" });
  cleo = await fleet.cardd.connect(fleet.cardd.addLane("cleo", "main"));
  const card = await newCard(fleet.main, "Users see one scrollbar");
  workerCard = card.id;
  workerToken = await begin(fleet.main, card);
  worker = await fleet.cardd.connect(workerToken);
});
afterEach(async () => {
  await Promise.allSettled([cleo.close(), worker.close()]);
  await fleet.cardd.stop();
});
const filed = (count: number): Promise<FakeIssue[]> =>
  poll(
    () => {
      const issues = fleet.cardd.gh.issues();
      return issues.length >= count ? issues : undefined;
    },
    `${String(count)} filed issue(s)`,
  );
const filingUnconfirmed = () =>
  poll(
    () =>
      fleet.cardd.errors.includes(
        `complaint filing unconfirmed for c-${String(workerCard)}-a1 on ${REPO}: gh issue create failed`,
      ) || undefined,
    "the unconfirmed filing line in cardd's log",
  );
const bodyLines = (issue: FakeIssue): string[] =>
  issue.body.split("\n").filter((line) => line.startsWith("- "));
function literalSentence(body: string): string {
  const match = /^ {4}([^\n]+)\n\n- Time: /.exec(body);
  assert.ok(match, body);
  return match[1] ?? "";
}
test("a worker's complaint becomes one issue with the time, role, lane, card, and project", async () => {
  const before = Date.now();
  const sentence = "The worker prompt never says where the evidence folder is.";
  assert.equal(await worker.call("complaint.publish", { text: sentence, card: 999 }), null);
  const [issue, ...others] = await filed(1);
  assert.equal(others.length, 0);
  assert.equal(issue?.repo, REPO);
  assert.equal(issue.title, sentence);
  assert.equal(literalSentence(issue.body), sentence);
  const [time, ...rest] = bodyLines(issue);
  assert.match(time ?? "", /^- Time: \d{4}-\d\d-\d\dT[\d:.]+Z$/);
  const at = Date.parse((time ?? "").replace("- Time: ", ""));
  assert.ok(at >= before && at <= Date.now());
  assert.deepEqual(rest, [
    "- Role: worker",
    "- Lane: `main`",
    `- Card: c-${String(workerCard)}`,
    "- Project: `web`",
  ]);
  assert.doesNotMatch(fleet.cardd.gh.calls().join("\n"), /--label/);
});

test("a long sentence gets a shortened title and keeps its whole text in the body", async () => {
  const prefix = `${"Slow ".repeat(15)}(`;
  const sentence = `${prefix}🧭) ${"🧭".repeat(270)}`;
  await worker.call("complaint.publish", { text: sentence });
  const [issue] = await filed(1);
  assert.equal(issue?.title, `${prefix}🧭...`);
  assert.equal(literalSentence(issue.body), sentence);
});
test("a mate's complaint names only a card it can see, and main can name any lane's card", async () => {
  const own = await newCard(cleo, "Cleo's own card");
  await cleo.call("complaint.publish", { text: "Closing a card is slow.", card: own.id });
  await filed(1);
  await cleo.call("complaint.publish", { text: "Foreign card feedback.", card: workerCard });
  await filed(2);
  await cleo.call("complaint.publish", { text: "The board header is noisy.", card: 999 });
  await filed(3);
  await cleo.call("complaint.publish", { text: "Dispatch has too many arguments." });
  await filed(4);
  await fleet.main.call("complaint.publish", { text: "Main can name Cleo's card.", card: own.id });
  const issues = await filed(5);
  assert.deepEqual(
    issues.map((issue) => [issue.title, ...bodyLines(issue).slice(1)]),
    [
      [
        "Closing a card is slow.",
        "- Role: mate",
        "- Lane: `cleo`",
        `- Card: c-${String(own.id)}`,
        "- Project: `web`",
      ],
      ["Foreign card feedback.", "- Role: mate", "- Lane: `cleo`"],
      ["The board header is noisy.", "- Role: mate", "- Lane: `cleo`"],
      ["Dispatch has too many arguments.", "- Role: mate", "- Lane: `cleo`"],
      [
        "Main can name Cleo's card.",
        "- Role: mate",
        "- Lane: `main`",
        `- Card: c-${String(own.id)}`,
        "- Project: `web`",
      ],
    ],
  );
});

test("lane and project names are published as literal code spans", async (t) => {
  const lane = "@ops/on-call";
  const project = "`@scope/**package**``";
  fleet.cardd.addProject(project, { maverick: "/clones/literal" }, "acme/literal");
  const mate = await fleet.cardd.connect(fleet.cardd.addLane(lane, "main"));
  t.after(() => mate.close());
  const card = check(
    CardSchema,
    await mate.call("card.new", {
      title: "Preserve literal attribution",
      kind: "ship",
      project,
    }),
  );
  await mate.call("complaint.publish", { text: "The board header is noisy.", card: card.id });

  const [issue] = await filed(1);
  assert.ok(issue);
  assert.deepEqual(bodyLines(issue).slice(1), [
    "- Role: mate",
    "- Lane: `@ops/on-call`",
    `- Card: c-${String(card.id)}`,
    "- Project: ``` `@scope/**package**`` ```",
  ]);
});

test("synthetic credential-shaped and email text is filed unchanged", async () => {
  const text = "The setup printed token=synthetic-example and user@example.test.";
  await worker.call("complaint.publish", { text });
  const [issue] = await filed(1);
  assert.equal(issue?.title, text);
  assert.equal(literalSentence(issue.body), text);
});
test("complaint markup, links and shorthand are confined to one literal block", async () => {
  const text = "``` <a> **bold** [go](/docs) ![pic](/p) https://x.co @ops #12 &commat;x";
  await worker.call("complaint.publish", { text });
  const [issue] = await filed(1);
  assert.equal(issue?.title, text);
  assert.equal(literalSentence(issue.body), text);
  assert.deepEqual(bodyLines(issue).slice(1), [
    "- Role: worker",
    "- Lane: `main`",
    `- Card: c-${String(workerCard)}`,
    "- Project: `web`",
  ]);
});
test("every line of a multiline complaint stays inside the literal block", async () => {
  const text = "Setup printed:\n![trace](https://example.test/trace.png)\n\n# heading";
  await worker.call("complaint.publish", { text });
  const [issue] = await filed(1);
  const [block] = issue?.body.split("\n\n- Time: ") ?? [];
  assert.equal(block, text.replace(/\n/g, "\n    ").replace(/^/, "    "));
});
test("long, blank, or NUL-containing text is refused and files nothing", async () => {
  await assert.rejects(
    worker.call("complaint.publish", { text: "x".repeat(501) }),
    /more than 500 characters/,
  );
  await assert.rejects(worker.call("complaint.publish", { text: "   " }), /invalid \/text/);
  const pasted = { text: "The formatter printed\u0000a NUL delimiter." };
  await assert.rejects(worker.call("complaint.publish", pasted), /invalid \/text/);
  const response = await fleet.cardd.post(workerToken, "complaint.publish", pasted);
  assert.partialDeepStrictEqual(response, { status: 400, body: { ok: false } });
  assert.match(JSON.stringify(response.body), /invalid \/text/);
  assert.deepEqual(fleet.cardd.gh.calls(), []);
  assert.deepEqual(fleet.cardd.gh.issues(), []);
});

test("the private recording operation is rejected without interrupting the worker's final report", async () => {
  const args = { text: "This was submitted under the private contract." };
  await assert.rejects(worker.call("complain", args), /unknown operation complain$/);
  await worker.call("report", { status: "done", text: "Work delivered." });
  const report = await fleet.main.waitForEntry(
    (entry) => entry.card === workerCard && entry.kind === "report",
    "the report on the same WebSocket",
  );
  assert.equal(report.body, "Work delivered.");
  assert.deepEqual(await fleet.cardd.post(fleet.mainToken, "complain", args), {
    status: 400,
    body: { ok: false, error: "unknown operation complain" },
  });
  const db = new DatabaseSync(fleet.cardd.db, { readOnly: true });
  try {
    assert.deepEqual(db.prepare("SELECT text FROM complaints").all(), []);
  } finally {
    db.close();
  }
  assert.deepEqual(fleet.cardd.gh.calls(), []);
  assert.deepEqual(fleet.cardd.gh.issues(), []);
});
test("an unrelated invalid WebSocket operation still closes the connection", async () => {
  await assert.rejects(worker.call("reprot", {}), /the connection closed/);
  assert.equal(worker.closeCode, CLOSE.badMessage);
});

test("an HTTP complaint is accepted only if the attempt is still live after upload", async (t) => {
  const accepted = "Feedback accepted before close.";
  assert.deepEqual(await fleet.cardd.post(workerToken, "complaint.publish", { text: accepted }), {
    status: 200,
    body: { ok: true, value: null },
  });
  await filed(1);

  const url = fleet.cardd.url.replace(/^ws/, "http").replace(/\/session$/, "/call");
  const json = JSON.stringify({
    op: "complaint.publish",
    args: { text: "Feedback that finishes uploading after close." },
  });
  const upload = request(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${workerToken}`,
      "content-type": "application/json",
      "content-length": Buffer.byteLength(json),
      expect: "100-continue",
    },
  });
  t.after(() => {
    upload.destroy();
  });
  const response = new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
    upload.once("error", reject);
    upload.once("response", (reply) => {
      reply.once("error", reject);
      reply.setEncoding("utf8");
      let body = "";
      reply.on("data", (chunk: string) => (body += chunk));
      reply.once("end", () => {
        resolve({ status: reply.statusCode, body });
      });
    });
  });
  const continued = once(upload, "continue", { signal: AbortSignal.timeout(5_000) });
  upload.flushHeaders();
  await continued;
  await fleet.main.call("close.begin", { card: workerCard, landed: false });
  await fleet.main.call("close.finish", {
    card: workerCard,
    mode: "dropped",
    text: "Work ended while feedback was uploading.",
    archives: [],
    left: [],
  });
  upload.end(json);

  assert.deepEqual(await response, {
    status: 400,
    body: JSON.stringify({ ok: false, error: "the session is not live" }),
  });
  assert.deepEqual(
    fleet.cardd.gh.issues().map(({ title }) => title),
    [accepted],
  );
  assert.equal(fleet.cardd.gh.calls().length, 1);
});

for (const echoesPayload of [false, true]) {
  test(`the worker can report before a failing filing, with ${echoesPayload ? "echoed" : "empty"} stderr kept out of logs`, async (t) => {
    const sentence = "Nothing reaches GitHub today.";
    fleet.cardd.gh.failIssues(echoesPayload ? `HTTP 502 rejected: ${sentence}` : "");
    const release = fleet.cardd.gh.holdIssues();
    t.after(release);
    assert.equal(await worker.call("complaint.publish", { text: sentence }), null);
    await worker.call("report", { status: "blocked", text: "carrying on" });
    const entry = await fleet.main.waitForEntry(
      (each) => each.card === workerCard && each.kind === "report",
      "the report while the filing is pending",
    );
    assert.equal(entry.body, "carrying on");
    await poll(() => fleet.cardd.gh.calls()[0], "the pending GitHub call");
    assert.doesNotMatch(fleet.cardd.errors, /complaint filing unconfirmed/);
    release();

    await filingUnconfirmed();
    assert.ok(!fleet.cardd.errors.includes(sentence));
    assert.ok(!fleet.cardd.errors.includes("HTTP 502"));
    assert.deepEqual(fleet.cardd.gh.issues(), []);
    const calls = fleet.cardd.gh.calls();
    assert.equal(calls.filter((call) => call.startsWith("issue create ")).length, 1);
    assert.doesNotMatch(calls.join("\n"), /--label/);
  });
}
