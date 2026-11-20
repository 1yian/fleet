import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import type { FakeIssue } from "../support/github.ts";
import type { Session } from "../support/cardd.ts";
import { begin, newCard, startFleet, type Fleet } from "../support/fleet.ts";
import { poll } from "../support/harness.ts";

const REPO = "1yian/fleet";

let fleet: Fleet;
let cleo: Session;
let worker: Session;
let workerCard: number;
beforeEach(async () => {
  fleet = await startFleet();
  cleo = await fleet.cardd.connect(fleet.cardd.addLane("cleo", "main"));
  const card = await newCard(fleet.main, "Users see one scrollbar");
  workerCard = card.id;
  worker = await fleet.cardd.connect(await begin(fleet.main, card));
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
const issueCalls = (): string[] =>
  fleet.cardd.gh.calls().filter((call) => call.startsWith("issue create"));
const bodyLines = (issue: FakeIssue): string[] =>
  issue.body.split("\n").filter((line) => line.startsWith("- "));

test("a worker's complaint becomes one issue labelled complaint, with the time, role, lane, card, and project", async () => {
  const before = Date.now();
  const sentence = "The worker prompt never says where the evidence folder is.";
  assert.equal(await worker.call("complain", { text: sentence, card: 999 }), null);

  const [issue, ...others] = await filed(1);
  assert.equal(others.length, 0);
  assert.equal(issue?.repo, REPO);
  assert.equal(issue.title, sentence);
  assert.deepEqual(issue.labels, ["complaint"]);
  assert.equal(issue.body.split("\n")[0], sentence);
  const [time, ...rest] = bodyLines(issue);
  assert.match(time ?? "", /^- Time: \d{4}-\d\d-\d\dT[\d:.]+Z$/);
  const at = Date.parse((time ?? "").replace("- Time: ", ""));
  assert.ok(at >= before && at <= Date.now());
  assert.deepEqual(rest, [
    "- Role: worker",
    "- Lane: main",
    `- Card: c-${String(workerCard)}`,
    "- Project: web",
  ]);
  assert.deepEqual(fleet.cardd.gh.labels(), ["complaint"]);
  assert.equal(fleet.cardd.gh.calls().filter((call) => call.startsWith("label create")).length, 1);
  assert.equal(issueCalls().length, 1);
});

test("a long sentence gets a shortened title and keeps its whole text in the body", async () => {
  const sentence = `${"The board header is noisy ".repeat(18)}end.`.slice(0, 500);
  await worker.call("complain", { text: sentence });

  const [issue] = await filed(1);
  assert.equal(issue?.title.length, 80);
  assert.ok(issue.title.endsWith("..."));
  assert.ok(sentence.startsWith(issue.title.slice(0, -3)));
  assert.equal(issue.body.split("\n")[0], sentence.trim());
});

test("a mate's complaint names only a card it can see, and main can name any lane's card", async () => {
  const own = await newCard(cleo, "Cleo's own card");
  await cleo.call("complain", { text: "Closing a card is slow.", card: own.id });
  await filed(1);
  await cleo.call("complain", { text: "Foreign card feedback.", card: workerCard });
  await filed(2);
  await cleo.call("complain", { text: "The board header is noisy.", card: 999 });
  await filed(3);
  await cleo.call("complain", { text: "Dispatch has too many arguments." });
  await filed(4);
  await fleet.main.call("complain", { text: "Main can name Cleo's card.", card: own.id });

  const issues = await filed(5);
  assert.deepEqual(
    issues.map((issue) => [issue.title, ...bodyLines(issue).slice(1)]),
    [
      [
        "Closing a card is slow.",
        "- Role: mate",
        "- Lane: cleo",
        `- Card: c-${String(own.id)}`,
        "- Project: web",
      ],
      ["Foreign card feedback.", "- Role: mate", "- Lane: cleo"],
      ["The board header is noisy.", "- Role: mate", "- Lane: cleo"],
      ["Dispatch has too many arguments.", "- Role: mate", "- Lane: cleo"],
      [
        "Main can name Cleo's card.",
        "- Role: mate",
        "- Lane: main",
        `- Card: c-${String(own.id)}`,
        "- Project: web",
      ],
    ],
  );
});

test("text that looks like a secret or an email address is scrubbed before it is filed", async () => {
  const secrets = [
    "abc123secret",
    "abcdefghijklmnop.qrstuv",
    "s3cret-pass",
    "jo.doe+fleet@example.com",
    "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    "AKIAIOSFODNN7EXAMPLE",
    "sk-live_abcdef12345678",
    "xoxb-123456789012-abcdefghijkl",
  ];
  await worker.call("complain", {
    text: "The setup printed token=abc123secret, Bearer abcdefghijklmnop.qrstuv, https://deploy:s3cret-pass@git.example.com/acme/web.git, mail jo.doe+fleet@example.com, ghp_abcdefghijklmnopqrstuvwxyz0123456789, AKIAIOSFODNN7EXAMPLE, sk-live_abcdef12345678 and xoxb-123456789012-abcdefghijkl to me.",
  });

  const [issue] = await filed(1);
  const everything = `${issue?.title ?? ""}\n${issue?.body ?? ""}`;
  for (const secret of secrets) assert.equal(everything.includes(secret), false, secret);
  const expected =
    "The setup printed token=[hidden], [hidden], https://[hidden]@git.example.com/acme/web.git, mail [hidden], [hidden], [hidden], [hidden] and [hidden] to me.";
  assert.equal(issue?.body.split("\n")[0], expected);
  assert.equal(issue.title, `${expected.slice(0, 77)}...`);
});

test("long or blank text is refused and files nothing", async () => {
  await assert.rejects(
    worker.call("complain", { text: "x".repeat(501) }),
    /more than 500 characters/,
  );
  await assert.rejects(worker.call("complain", { text: "   " }), /invalid \/text/);
  assert.deepEqual(fleet.cardd.gh.calls(), []);
  assert.deepEqual(fleet.cardd.gh.issues(), []);
});

test("a filing failure drops the complaint, is logged in cardd's log, and the caller carries on", async () => {
  fleet.cardd.gh.failIssues("HTTP 502: Bad Gateway (https://api.github.com/graphql)");
  assert.equal(await worker.call("complain", { text: "Nothing reaches GitHub today." }), null);
  await poll(
    () =>
      fleet.cardd.errors.includes(
        `a complaint from c-${String(workerCard)}-a1 was dropped, not filed on ${REPO}: HTTP 502: Bad Gateway`,
      )
        ? true
        : undefined,
    "the dropped-complaint line in cardd's log",
  );

  assert.deepEqual(fleet.cardd.gh.issues(), []);
  assert.equal(issueCalls().length, 1);
  await worker.call("report", { status: "blocked", text: "carrying on" });
  const entry = await fleet.main.waitForEntry(
    (each) => each.card === workerCard && each.kind === "report",
    "the report after the dropped complaint",
  );
  assert.equal(entry.body, "carrying on");
});

test("a label that cannot be created is logged, and the issue is still filed without it", async () => {
  fleet.cardd.gh.failLabels("HTTP 403: Resource not accessible by personal access token");
  await worker.call("complain", { text: "The label step lacks permission." });

  const [issue] = await filed(1);
  assert.deepEqual(issue?.labels, []);
  assert.equal(issue.title, "The label step lacks permission.");
  assert.match(
    fleet.cardd.errors,
    /could not create the complaint label on 1yian\/fleet: HTTP 403: Resource not accessible/,
  );
});
